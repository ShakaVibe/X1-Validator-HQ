    // ───────────────────────────────────────────────
    // Reliable transaction SEND path (priority fee + rebroadcast).
    //
    // WHY: X1 (like Solana) will silently DROP a valid, simulated-OK tx when
    // the network is busy if it (a) carries no priority fee, so it loses the
    // fee auction, and/or (b) is broadcast only once, so a single dropped
    // packet loses it forever. Both were true of every send in this app, which
    // is why withdrawals were "confirming out" without the funds ever moving.
    //
    // This helper fixes both for EVERY signed action that routes through it:
    //   1. Attaches a ComputeBudget priority fee so the tx is worth including.
    //   2. Prefers signTransaction (so WE hold the signed bytes) and then
    //      re-broadcasts the exact same signed tx every few seconds until it
    //      confirms or its blockhash expires. Wallets that only expose
    //      signAndSendTransaction still work — they just don't get rebroadcast.
    //
    // Pair the returned signature with confirmWithFallback() for confirmation.
    // ───────────────────────────────────────────────

    // Priority fee knobs. Total extra cost ≈ price × limit / 1e6 lamports.
    // 50000 µLamports/CU × 200000 CU = 10,000 lamports = 0.00001 XNT — tiny,
    // but enough to win inclusion under load. Bump PRIORITY_FEE_MICROLAMPORTS
    // if X1 gets congested and txs still lag.
    const PRIORITY_FEE_MICROLAMPORTS   = 50000;
    const PRIORITY_COMPUTE_UNIT_LIMIT  = 200000;
    const COMPUTE_BUDGET_PROGRAM_ID    = 'ComputeBudget111111111111111111111111111111';

    // Dynamic priority fee: start at the floor, then adjust to what's actually
    // landing on-chain right now (getRecentPrioritizationFees). Cached briefly so
    // a burst of signed actions doesn't hammer the RPC, and clamped so we never
    // drop below a sane floor or wildly overpay. Falls back to the floor if the
    // RPC doesn't support the call.
    const PRIORITY_FEE_FLOOR_MICROLAMPORTS = PRIORITY_FEE_MICROLAMPORTS; // never below this
    const PRIORITY_FEE_CEIL_MICROLAMPORTS  = 1000000; // never above this (0.0002 XNT @ 200k CU)
    const PRIORITY_FEE_TTL_MS              = 15000;    // reuse a fetched value for 15s
    let _dynamicPriorityFee   = PRIORITY_FEE_MICROLAMPORTS;
    let _priorityFeeFetchedAt = 0;

    async function refreshPriorityFee(connection) {
      try {
        if (!connection || typeof connection.getRecentPrioritizationFees !== 'function') {
          return _dynamicPriorityFee;
        }
        const now = Date.now();
        if (now - _priorityFeeFetchedAt < PRIORITY_FEE_TTL_MS) return _dynamicPriorityFee;
        _priorityFeeFetchedAt = now;
        const fees = await connection.getRecentPrioritizationFees();
        if (Array.isArray(fees) && fees.length) {
          const vals = fees
            .map(f => Number(f && f.prioritizationFee) || 0)
            .sort((a, b) => a - b);
          // 75th percentile of recent fees + 20% headroom, clamped to [floor, ceil].
          const idx = Math.min(vals.length - 1, Math.floor(vals.length * 0.75));
          let fee = Math.ceil((vals[idx] || 0) * 1.2);
          fee = Math.max(PRIORITY_FEE_FLOOR_MICROLAMPORTS, Math.min(PRIORITY_FEE_CEIL_MICROLAMPORTS, fee));
          _dynamicPriorityFee = fee;
        }
      } catch (e) {
        console.warn('refreshPriorityFee: using floor —', e && e.message ? e.message : e);
      }
      return _dynamicPriorityFee;
    }

    // Prepend a compute-unit-limit + priority-fee instruction to a tx.
    // No-ops safely if ComputeBudgetProgram is unavailable or already added.
    // CRITICAL: never mutate a transaction that already carries a signature —
    // adding an instruction after signing invalidates that signature and the
    // network rejects it with "signature verification failure". Transactions
    // that are partialSign'd with an extra keypair (create-stake, split) must
    // therefore call addPriorityFee BEFORE they partialSign; this guard makes a
    // later call from signSendTx a safe no-op for them.
    function addPriorityFee(transaction) {
      try {
        const { ComputeBudgetProgram } = solanaWeb3;
        if (!ComputeBudgetProgram || !transaction || typeof transaction.add !== 'function') {
          return transaction;
        }
        const alreadySigned = Array.isArray(transaction.signatures) &&
          transaction.signatures.some(s => s && s.signature);
        if (alreadySigned) return transaction;
        const already = (transaction.instructions || []).some(ix =>
          ix && ix.programId && ix.programId.toString() === COMPUTE_BUDGET_PROGRAM_ID);
        if (already) return transaction;
        transaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_COMPUTE_UNIT_LIMIT }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: _dynamicPriorityFee })
        );
      } catch (e) {
        console.warn('addPriorityFee: could not attach priority fee:', e);
      }
      return transaction;
    }

    // Normalize the many shapes a wallet may return for a signature.
    function normalizeSignature(sig) {
      if (!sig) return sig;
      if (typeof sig === 'string') return sig;
      if (sig.signature) return sig.signature;
      return String(sig);
    }

    // Build a link to a transaction on the X1 block explorer.
    const EXPLORER_TX_BASE = 'https://explorer.x1.xyz/tx/';
    function explorerTxUrl(signature) {
      return EXPLORER_TX_BASE + encodeURIComponent(normalizeSignature(signature));
    }

    // Shared renderer for the transaction status boxes in every action modal.
    // Sets the message as TEXT (never HTML, so on-chain/user strings can't inject
    // markup) and, when a signature is supplied, appends a real "View on X1
    // Explorer" link built as a DOM node — handy for verifying a tx after a
    // "may still have gone through" timeout, or just checking a success.
    function renderTxMessage(elId, message, type, signature) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = message;
      el.className = 'send-message ' + type;
      el.style.display = 'block';
      const sig = signature ? normalizeSignature(signature) : null;
      if (sig) {
        el.appendChild(document.createElement('br'));
        const a = document.createElement('a');
        a.href = explorerTxUrl(sig);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tx-explorer-link';
        a.textContent = 'View on X1 Explorer ↗';
        el.appendChild(a);
      }
    }

    // Fire-and-forget rebroadcast loop for an already-signed raw tx. Re-sends
    // the identical bytes every 2.5s (up to ~50s) and stops early once the
    // signature is seen confirmed/finalized. Re-sending an already-landed tx is
    // a harmless no-op, so there's no risk of double-spend.
    function startRebroadcast(connection, rawTx, signature) {
      if (!rawTx || !signature) return;
      let ticks = 0;
      const tick = async () => {
        if (ticks++ >= 20) return;
        try {
          const st = await connection.getSignatureStatus(signature);
          const cs = st && st.value ? st.value.confirmationStatus : null;
          if (cs === 'confirmed' || cs === 'finalized') return; // landed — stop
        } catch (e) { /* status check failed; keep trying to send */ }
        try {
          await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
        } catch (e) { /* transient send error; keep looping */ }
        setTimeout(tick, 2500);
      };
      setTimeout(tick, 2500);
    }

    // Sign + send a transaction with priority fee and rebroadcast, returning
    // the signature string. The tx must already have recentBlockhash + feePayer
    // set by the caller. Throws on wallet rejection or a real send/preflight
    // error (so callers' existing catch blocks still work).
    async function signSendTx(connection, transaction) {
      await refreshPriorityFee(connection);
      addPriorityFee(transaction);
      const provider = connectedWallet && connectedWallet.provider;
      if (!provider) throw new Error('Wallet not connected properly');

      let signature = null;
      let rawTx = null;

      if (provider.signTransaction) {
        // Preferred path: we hold the signed bytes, so we can rebroadcast and
        // we know the blockhash the wallet signed matches what we'll confirm.
        const signed = await provider.signTransaction(transaction);
        rawTx = signed.serialize();
        signature = await connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 5
        });
      } else {
        // Wallet only supports signAndSendTransaction: it controls sending, so
        // no manual rebroadcast, but the priority fee still applies.
        const result = await provider.signAndSendTransaction(transaction);
        signature = (result && result.signature) ? result.signature : result;
      }

      signature = normalizeSignature(signature);
      startRebroadcast(connection, rawTx, signature);
      return signature;
    }


    // ───────────────────────────────────────────────
    // Shared transaction-confirmation helper.
    //
    // A "block height exceeded" / "expired" error from confirmTransaction is a
    // CONFIRMATION TIMEOUT, not proof of failure: the wallet's confirmation
    // watcher stopped waiting at lastValidBlockHeight, but the transaction may
    // still have landed (lagging RPC node, dropped websocket notification, or
    // inclusion right around the deadline). On that specific error we re-check the
    // signature on-chain a few times and only report failure if it genuinely
    // failed or never appeared.
    //
    // Returns void on success. Throws on a real failure. Pass the same
    // connection/signature/blockhash/lastValidBlockHeight used to send the tx.
    async function confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, commitment = 'confirmed') {
      try {
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          commitment
        );
        if (confirmation && confirmation.value && confirmation.value.err) {
          throw new Error('Transaction failed to confirm: ' + JSON.stringify(confirmation.value.err));
        }
        return; // confirmed cleanly
      } catch (e) {
        const looksExpired = e && e.message && (
          e.message.includes('block height exceeded') ||
          e.message.includes('expired') ||
          e.message.includes('TransactionExpired')
        );
        // Genuine failure (including a real on-chain error) — propagate as-is.
        if (!looksExpired) throw e;

        // Confirmation watcher gave up. Verify on-chain before declaring failure.
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          let status;
          try {
            status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
          } catch (statusErr) {
            console.error('getSignatureStatus failed during verification:', statusErr);
            continue;
          }
          const v = status && status.value ? status.value : null;
          if (!v) continue;
          if (v.err) {
            throw new Error('Transaction failed on-chain: ' + JSON.stringify(v.err));
          }
          if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
            return; // it landed successfully
          }
        }

        const timeoutErr = new Error('the network did not confirm in time. Your transaction may still have gone through — please check before retrying.');
        timeoutErr.isUnconfirmedTimeout = true;
        throw timeoutErr;
      }
    }

    async function confirmCreateStake() {
      const amountInput = document.getElementById('createStakeAmountInput');
      const amount = parseFloat(amountInput.value);
      
      if (!amount || amount <= 0) {
        showCreateStakeMessage('Please enter a valid amount.', 'error');
        return;
      }
      
      const stakeLamports = Math.floor(amount * 1000000000);
      const totalRequired = stakeLamports + STAKE_ACCOUNT_RENT + 5000; // stake + rent + fee
      
      if (totalRequired > createStakeWalletBalanceLamports) {
        showCreateStakeMessage('Insufficient balance for stake amount plus rent and fees.', 'error');
        return;
      }
      
      const btn = document.getElementById('createStakeConfirmBtn');
      
      try {
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showCreateStakeMessage('Creating stake account...', 'info');
        
        const { Connection, PublicKey, Transaction, Keypair, StakeProgram } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const fromPubkey = new PublicKey(walletPublicKey);
        const votePubkey = new PublicKey(currentManageValidator.voteAccount);
        
        // Log for debugging
        console.log('Creating stake with authorities set to:', walletPublicKey);
        console.log('fromPubkey:', fromPubkey.toString());
        console.log('votePubkey:', votePubkey.toString());
        console.log('stakeLamports:', stakeLamports);
        
        // Generate a new keypair for the stake account
        const stakeAccount = Keypair.generate();
        console.log('New stake account:', stakeAccount.publicKey.toString());
        
        // Calculate total lamports needed (stake amount + rent)
        const totalLamports = stakeLamports + STAKE_ACCOUNT_RENT;
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        console.log('Got blockhash:', blockhash);
        
        // StakeProgram.createAccount returns a Transaction object
        const createAccountTx = StakeProgram.createAccount({
          fromPubkey: fromPubkey,
          stakePubkey: stakeAccount.publicKey,
          authorized: {
            staker: fromPubkey,
            withdrawer: fromPubkey
          },
          lockup: {
            unixTimestamp: 0,
            epoch: 0,
            custodian: fromPubkey
          },
          lamports: totalLamports
        });
        
        // Delegate stake to validator
        const delegateTx = StakeProgram.delegate({
          stakePubkey: stakeAccount.publicKey,
          authorizedPubkey: fromPubkey,
          votePubkey: votePubkey
        });
        
        // Build transaction - extract instructions from the returned transactions
        const transaction = new Transaction();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPubkey;
        
        // Add instructions from createAccount (may be Transaction or have instructions array)
        if (createAccountTx.instructions) {
          createAccountTx.instructions.forEach(ix => transaction.add(ix));
        } else {
          transaction.add(createAccountTx);
        }
        
        // Add instructions from delegate
        if (delegateTx.instructions) {
          delegateTx.instructions.forEach(ix => transaction.add(ix));
        } else {
          transaction.add(delegateTx);
        }
        
        console.log('Transaction built with', transaction.instructions.length, 'instructions');
        
        // Attach the priority fee BEFORE partialSign — adding instructions after
        // signing would invalidate the stake account's signature.
        await refreshPriorityFee(connection);
        addPriorityFee(transaction);
        
        // The stake account keypair needs to sign
        transaction.partialSign(stakeAccount);
        console.log('Partially signed with stake account');
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showCreateStakeMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign with wallet and send
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showCreateStakeMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          // Wait for confirmation
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeCreateStakeModal;
          btn.disabled = false;
          document.getElementById('createStakeCancelBtn').textContent = 'Close';
          showCreateStakeMessage(`Stake created and delegated! Account: ${stakeAccount.publicKey.toString().slice(0, 12)}... Signature: ${String(signature).slice(0, 16)}...`, 'success', signature);
          
          // Refresh balances and stake accounts after a delay (but don't auto-close modal)
          setTimeout(() => {
            fetchCreateStakeWalletBalance();
            // Refresh the stake accounts list in the Manage Validator modal
            if (currentManageValidator && currentManageValidator.voteAccount) {
              fetchStakeAccounts(currentManageValidator.voteAccount);
            }
          }, 3000);
          
        } else {
          throw new Error('Wallet not connected properly');
        }
        
      } catch (e) {
        console.error('Create stake error:', e);
        
        btn.disabled = false;
        btn.textContent = 'Create & Delegate Stake';
        
        if (e.message && (e.message.includes('User rejected') || e.message.includes('rejected'))) {
          showCreateStakeMessage('Transaction cancelled by user.', 'error');
        } else if (e.message && e.message.includes('Plugin Closed')) {
          showCreateStakeMessage('Wallet closed unexpectedly. Please try again.', 'error');
        } else {
          showCreateStakeMessage(`Transaction failed: ${e.message || 'Unknown error'}`, 'error');
        }
      }
    }

    function showCreateStakeMessage(message, type, signature) {
      renderTxMessage('createStakeMessage', message, type, signature);
    }

    // Track current stake for authority changes
    let currentAuthorityStake = null;

    function initiateSetWithdrawAuthority() {
      if (!walletPublicKey) {
        showWalletRequired('set withdraw authority');
        return;
      }
      
      // Get selected stake account
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Please select a stake account first.');
        return;
      }
      
      currentAuthorityStake = stake;
      const withdrawer = stake.data.meta?.authorized?.withdrawer;
      
      // Populate modal
      document.getElementById('setWithdrawStakeAddress').textContent = stake.pubkey;
      document.getElementById('setWithdrawStakeCopyBtn').innerHTML = getCopyButtonHtml(stake.pubkey);
      document.getElementById('setWithdrawCurrentAuthority').textContent = withdrawer || 'Unknown';
      if (withdrawer) {
        document.getElementById('setWithdrawCurrentCopyBtn').innerHTML = getCopyButtonHtml(withdrawer);
      }
      document.getElementById('setWithdrawNewAuthority').value = '';
      document.getElementById('setWithdrawAuthorityMessage').style.display = 'none';
      document.getElementById('setWithdrawAuthorityBtn').disabled = true;
      document.getElementById('setWithdrawAuthorityBtn').textContent = 'Set New Authority';
      document.getElementById('setWithdrawAuthorityBtn').onclick = confirmSetWithdrawAuthority;
      document.getElementById('setWithdrawAuthorityCancelBtn').textContent = 'Cancel';
      
      // Check authority
      if (withdrawer && withdrawer !== walletPublicKey) {
        document.getElementById('withdrawAuthorityWarning2').style.display = 'flex';
        document.getElementById('setWithdrawAuthorityBtn').disabled = true;
      } else {
        document.getElementById('withdrawAuthorityWarning2').style.display = 'none';
      }
      
      // Show modal
      document.getElementById('setWithdrawAuthorityModal').style.display = 'flex';
    }

    function closeSetWithdrawAuthorityModal() {
      document.getElementById('setWithdrawAuthorityModal').style.display = 'none';
      currentAuthorityStake = null;
    }

    function validateWithdrawAuthorityInput() {
      const newAuthority = document.getElementById('setWithdrawNewAuthority').value.trim();
      const btn = document.getElementById('setWithdrawAuthorityBtn');
      const withdrawer = currentAuthorityStake?.data.meta?.authorized?.withdrawer;
      
      // Validate address is a real base58 pubkey (not just length)
      if (isValidPubkey(newAuthority) && withdrawer === walletPublicKey) {
        btn.disabled = false;
      } else {
        btn.disabled = true;
      }
    }

    async function confirmSetWithdrawAuthority() {
      const newAuthority = document.getElementById('setWithdrawNewAuthority').value.trim();
      
      if (!newAuthority || !currentAuthorityStake) {
        showSetWithdrawAuthorityMessage('Please enter a valid public key.', 'error');
        return;
      }

      if (!isValidPubkey(newAuthority)) {
        showSetWithdrawAuthorityMessage('That is not a valid address. Double-check the public key — this action is irreversible.', 'error');
        return;
      }
      
      try {
        const btn = document.getElementById('setWithdrawAuthorityBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showSetWithdrawAuthorityMessage('Setting new withdraw authority...', 'info');
        
        const { Connection, PublicKey, Transaction, StakeProgram } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const stakePubkey = new PublicKey(currentAuthorityStake.pubkey);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        const newAuthorizedPubkey = new PublicKey(newAuthority);
        
        // Create authorize instruction
        const authorizeInstruction = StakeProgram.authorize({
          stakePubkey: stakePubkey,
          authorizedPubkey: authorizedPubkey,
          newAuthorizedPubkey: newAuthorizedPubkey,
          stakeAuthorizationType: { index: 1 } // 1 = Withdrawer
        });
        
        const transaction = new Transaction().add(authorizeInstruction);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showSetWithdrawAuthorityMessage('Please approve the transaction in your wallet...', 'info');
        
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showSetWithdrawAuthorityMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeSetWithdrawAuthorityModal;
          btn.disabled = false;
          document.getElementById('setWithdrawAuthorityCancelBtn').textContent = 'Close';
          showSetWithdrawAuthorityMessage(`Withdraw authority updated! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
          
          // Remember current selection
          const currentSelection = selectedAccountType;
          
          // Refresh stake accounts and re-select to update details (but don't auto-close modal)
          setTimeout(async () => {
            if (currentManageValidator && currentManageValidator.voteAccount) {
              await fetchStakeAccounts(currentManageValidator.voteAccount);
              // Re-select the stake account to refresh the details panel
              setTimeout(() => {
                if (currentSelection && currentSelection.startsWith('stake-')) {
                  selectAccount(currentSelection);
                }
              }, 200);
            }
          }, 2000);
          
        } else {
          throw new Error('Wallet not connected');
        }
        
      } catch (e) {
        console.error('Set withdraw authority error:', e);
        const btn = document.getElementById('setWithdrawAuthorityBtn');
        btn.disabled = false;
        btn.textContent = 'Set New Authority';
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showSetWithdrawAuthorityMessage('Transaction cancelled by user.', 'error');
        } else {
          showSetWithdrawAuthorityMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
      }
    }

    function showSetWithdrawAuthorityMessage(message, type, signature) {
      renderTxMessage('setWithdrawAuthorityMessage', message, type, signature);
    }

    function initiateSetStakeAuthority() {
      if (!walletPublicKey) {
        showWalletRequired('set stake authority');
        return;
      }
      
      // Get selected stake account
      const stakeIndex = parseInt(selectedAccountType.replace('stake-', ''));
      const stake = stakeAccounts[stakeIndex];
      
      if (!stake) {
        alert('Please select a stake account first.');
        return;
      }
      
      currentAuthorityStake = stake;
      const staker = stake.data.meta?.authorized?.staker;
      
      // Populate modal
      document.getElementById('setStakerStakeAddress').textContent = stake.pubkey;
      document.getElementById('setStakerStakeCopyBtn').innerHTML = getCopyButtonHtml(stake.pubkey);
      document.getElementById('setStakerCurrentAuthority').textContent = staker || 'Unknown';
      if (staker) {
        document.getElementById('setStakerCurrentCopyBtn').innerHTML = getCopyButtonHtml(staker);
      }
      document.getElementById('setStakerNewAuthority').value = '';
      document.getElementById('setStakeAuthorityMessage').style.display = 'none';
      document.getElementById('setStakeAuthorityBtn').disabled = true;
      document.getElementById('setStakeAuthorityBtn').textContent = 'Set New Authority';
      document.getElementById('setStakeAuthorityBtn').onclick = confirmSetStakeAuthority;
      document.getElementById('setStakeAuthorityCancelBtn').textContent = 'Cancel';
      
      // Check authority
      if (staker && staker !== walletPublicKey) {
        document.getElementById('stakeAuthorityWarning2').style.display = 'flex';
        document.getElementById('setStakeAuthorityBtn').disabled = true;
      } else {
        document.getElementById('stakeAuthorityWarning2').style.display = 'none';
      }
      
      // Show modal
      document.getElementById('setStakeAuthorityModal').style.display = 'flex';
    }

    function closeSetStakeAuthorityModal() {
      document.getElementById('setStakeAuthorityModal').style.display = 'none';
      currentAuthorityStake = null;
    }

    function validateStakeAuthorityInput() {
      const newAuthority = document.getElementById('setStakerNewAuthority').value.trim();
      const btn = document.getElementById('setStakeAuthorityBtn');
      const staker = currentAuthorityStake?.data.meta?.authorized?.staker;
      
      if (isValidPubkey(newAuthority) && staker === walletPublicKey) {
        btn.disabled = false;
      } else {
        btn.disabled = true;
      }
    }

    async function confirmSetStakeAuthority() {
      const newAuthority = document.getElementById('setStakerNewAuthority').value.trim();
      
      if (!newAuthority || !currentAuthorityStake) {
        showSetStakeAuthorityMessage('Please enter a valid public key.', 'error');
        return;
      }

      if (!isValidPubkey(newAuthority)) {
        showSetStakeAuthorityMessage('That is not a valid address. Double-check the public key — this action is irreversible.', 'error');
        return;
      }
      
      try {
        const btn = document.getElementById('setStakeAuthorityBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showSetStakeAuthorityMessage('Setting new stake authority...', 'info');
        
        const { Connection, PublicKey, Transaction, StakeProgram } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const stakePubkey = new PublicKey(currentAuthorityStake.pubkey);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        const newAuthorizedPubkey = new PublicKey(newAuthority);
        
        // Create authorize instruction
        const authorizeInstruction = StakeProgram.authorize({
          stakePubkey: stakePubkey,
          authorizedPubkey: authorizedPubkey,
          newAuthorizedPubkey: newAuthorizedPubkey,
          stakeAuthorizationType: { index: 0 } // 0 = Staker
        });
        
        const transaction = new Transaction().add(authorizeInstruction);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showSetStakeAuthorityMessage('Please approve the transaction in your wallet...', 'info');
        
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showSetStakeAuthorityMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeSetStakeAuthorityModal;
          btn.disabled = false;
          document.getElementById('setStakeAuthorityCancelBtn').textContent = 'Close';
          showSetStakeAuthorityMessage(`Stake authority updated! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
          
          // Remember current selection
          const currentSelection = selectedAccountType;
          
          // Refresh stake accounts and re-select to update details (but don't auto-close modal)
          setTimeout(async () => {
            if (currentManageValidator && currentManageValidator.voteAccount) {
              await fetchStakeAccounts(currentManageValidator.voteAccount);
              // Re-select the stake account to refresh the details panel
              setTimeout(() => {
                if (currentSelection && currentSelection.startsWith('stake-')) {
                  selectAccount(currentSelection);
                }
              }, 200);
            }
          }, 2000);
          
        } else {
          throw new Error('Wallet not connected');
        }
        
      } catch (e) {
        console.error('Set stake authority error:', e);
        const btn = document.getElementById('setStakeAuthorityBtn');
        btn.disabled = false;
        btn.textContent = 'Set New Authority';
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showSetStakeAuthorityMessage('Transaction cancelled by user.', 'error');
        } else {
          showSetStakeAuthorityMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
      }
    }

    function showSetStakeAuthorityMessage(message, type, signature) {
      renderTxMessage('setStakeAuthorityMessage', message, type, signature);
    }

    // Wallet Connection State
    let connectedWallet = null;
    let walletPublicKey = null;

    // Check for available wallets
    function getAvailableWallets() {
      const wallets = [];
      
      // X1 Wallet - prioritized first
      if (window.x1?.isX1Wallet) {
        wallets.push({ name: 'X1 Wallet', provider: window.x1, icon: 'x1-logo' });
      }
      if (window.phantom?.solana) {
        wallets.push({ name: 'Phantom', provider: window.phantom.solana, icon: '👻' });
      }
      if (window.solflare) {
        wallets.push({ name: 'Solflare', provider: window.solflare, icon: '🔆' });
      }
      if (window.backpack) {
        wallets.push({ name: 'Backpack', provider: window.backpack, icon: '🎒' });
      }
      if (window.solana && !window.phantom && !window.x1) {
        wallets.push({ name: 'Solana Wallet', provider: window.solana, icon: '💎' });
      }
      
      return wallets;
    }

    // Connect wallet
    async function connectWallet() {
      const wallets = getAvailableWallets();
      
      if (wallets.length === 0) {
        showWalletModal();
        return;
      }
      
      if (wallets.length === 1) {
        await connectToProvider(wallets[0]);
      } else {
        showWalletSelectModal(wallets);
      }
    }

    // Show modal when no wallet is installed
    function showWalletModal() {
      const modal = document.createElement('div');
      modal.className = 'wallet-install-modal';
      modal.id = 'walletInstallModal';
      modal.innerHTML = `
        <div class="wallet-install-content">
          <h3>No Wallet Detected</h3>
          <p>Please install a Solana-compatible wallet to continue:</p>
          <div class="wallet-options">
            <a href="https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae" target="_blank" rel="noopener noreferrer" class="wallet-option">
              <span class="wallet-option-icon x1-wallet-icon"><img src="data:image/webp;base64,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" alt="X1 Wallet"></span>
              <span>X1 Wallet</span>
            </a>
            <a href="https://phantom.app/" target="_blank" rel="noopener noreferrer" class="wallet-option">
              <span class="wallet-option-icon">👻</span>
              <span>Phantom</span>
            </a>
            <a href="https://solflare.com/" target="_blank" rel="noopener noreferrer" class="wallet-option">
              <span class="wallet-option-icon">🔆</span>
              <span>Solflare</span>
            </a>
            <a href="https://backpack.app/" target="_blank" rel="noopener noreferrer" class="wallet-option">
              <span class="wallet-option-icon">🎒</span>
              <span>Backpack</span>
            </a>
          </div>
          <button class="wallet-modal-close" onclick="closeWalletInstallModal()">Close</button>
        </div>
      `;
      document.body.appendChild(modal);
      modal.style.display = 'flex';
    }

    function closeWalletInstallModal() {
      const modal = document.getElementById('walletInstallModal');
      if (modal) modal.remove();
    }

    // Show wallet selection modal
    function showWalletSelectModal(wallets) {
      const modal = document.createElement('div');
      modal.className = 'wallet-install-modal';
      modal.id = 'walletSelectModal';
      
      const x1LogoBase64 = 'data:image/webp;base64,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';
      
      const walletButtons = wallets.map(w => {
        const iconHtml = w.icon === 'x1-logo' 
          ? `<span class="wallet-option-icon x1-wallet-icon"><img src="${x1LogoBase64}" alt="X1 Wallet"></span>`
          : `<span class="wallet-option-icon">${w.icon}</span>`;
        return `
          <button class="wallet-option" onclick="selectWallet('${w.name}')">
            ${iconHtml}
            <span>${w.name}</span>
          </button>
        `;
      }).join('');
      
      modal.innerHTML = `
        <div class="wallet-install-content">
          <h3>Select Wallet</h3>
          <p>Choose a wallet to connect:</p>
          <div class="wallet-options">
            ${walletButtons}
          </div>
          <button class="wallet-modal-close" onclick="closeWalletSelectModal()">Cancel</button>
        </div>
      `;
      document.body.appendChild(modal);
      modal.style.display = 'flex';
    }

    function closeWalletSelectModal() {
      const modal = document.getElementById('walletSelectModal');
      if (modal) modal.remove();
    }

    async function selectWallet(walletName) {
      closeWalletSelectModal();
      const wallets = getAvailableWallets();
      const wallet = wallets.find(w => w.name === walletName);
      if (wallet) {
        await connectToProvider(wallet);
      }
    }

    // Connect to a specific wallet provider
    async function connectToProvider(wallet) {
      try {
        updateWalletStatus('Connecting...', 'connecting');
        
        const response = await wallet.provider.connect();
        
        connectedWallet = wallet;
        walletPublicKey = response.publicKey.toString();
        
        // Update UI
        updateWalletStatus(`${wallet.icon} ${shortenAddress(walletPublicKey)}`, 'connected');
        document.getElementById('connectWalletBtn').style.display = 'none';
        document.getElementById('disconnectWalletBtn').style.display = 'block';
        
        // Update wallet status display in manage modal
        updateManageWalletDisplay();
        
        // If manage modal is open, refresh stake accounts to get fresh authority data
        if (currentManageValidator && currentManageValidator.voteAccount) {
          const currentSelection = selectedAccountType;
          fetchStakeAccounts(currentManageValidator.voteAccount).then(() => {
            if (currentSelection && currentSelection.startsWith('stake-')) {
              setTimeout(() => selectAccount(currentSelection), 100);
            }
          });
        }
        
        // Listen for disconnect
        wallet.provider.on('disconnect', handleDisconnect);
        wallet.provider.on('accountChanged', handleAccountChange);
        
        console.log('Wallet connected:', walletPublicKey);
        
      } catch (error) {
        console.error('Wallet connection error:', error);
        updateWalletStatus('Connection failed', 'error');
        setTimeout(() => {
          updateWalletStatus('No wallet connected', 'disconnected');
        }, 2000);
      }
    }

    function handleDisconnect() {
      connectedWallet = null;
      walletPublicKey = null;
      updateWalletStatus('No wallet connected', 'disconnected');
      document.getElementById('connectWalletBtn').style.display = 'block';
      document.getElementById('disconnectWalletBtn').style.display = 'none';
      
      // Update manage modal if open
      const indicator = document.getElementById('walletStatusIndicator');
      if (indicator) {
        indicator.classList.remove('connected');
        document.getElementById('walletStatusText').classList.remove('connected');
        document.getElementById('selectedWithdrawAuthority').textContent = 'Connect wallet to view';
        
        // Update authority badge (clickable)
        const authorityBadge = document.getElementById('authorityBadge');
        if (authorityBadge) {
          authorityBadge.className = 'authority-badge clickable';
          authorityBadge.innerHTML = '<span class="authority-badge-icon">🔗</span><span class="authority-badge-text">No wallet connected</span>';
        }
        
        // If a stake account is selected, re-select it to update authority badges
        if (selectedAccountType && selectedAccountType.startsWith('stake-')) {
          selectAccount(selectedAccountType);
        }
      }
    }

    function handleAccountChange(newPublicKey) {
      if (newPublicKey) {
        walletPublicKey = newPublicKey.toString();
        updateWalletStatus(shortenAddress(walletPublicKey), 'connected');
        updateManageWalletDisplay();
        
        // If manage modal is open, refresh stake accounts to get fresh authority data
        if (currentManageValidator && currentManageValidator.voteAccount) {
          const currentSelection = selectedAccountType;
          fetchStakeAccounts(currentManageValidator.voteAccount).then(() => {
            // After refresh, re-select the account to update badges
            if (currentSelection && currentSelection.startsWith('stake-')) {
              setTimeout(() => selectAccount(currentSelection), 100);
            }
          });
        }
        
        console.log('Wallet account changed to:', walletPublicKey);
      } else {
        handleDisconnect();
      }
    }

    async function disconnectWallet() {
      if (connectedWallet && connectedWallet.provider) {
        try {
          await connectedWallet.provider.disconnect();
        } catch (e) {
          console.log('Disconnect error:', e);
        }
      }
      handleDisconnect();
    }

    function updateWalletStatus(text, status) {
      const statusEl = document.getElementById('walletStatusText');
      if (statusEl) {
        statusEl.textContent = text;
        if (status === 'connected') {
          statusEl.classList.add('connected');
        } else {
          statusEl.classList.remove('connected');
        }
      }
    }

    function shortenAddress(address) {
      if (!address) return '';
      return address.slice(0, 4) + '...' + address.slice(-4);
    }

    // Check if connected wallet has withdraw authority
    async function checkWithdrawAuthority() {
      if (!walletPublicKey || !currentManageValidator) return;
      
      const authorityBadge = document.getElementById('authorityBadge');
      
      try {
        // Fetch vote account info to get withdraw authority
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result && data.result.value) {
          const parsed = data.result.value.data.parsed;
          if (parsed && parsed.info) {
            const authorizedWithdrawer = parsed.info.authorizedWithdrawer;
            
            document.getElementById('selectedWithdrawAuthority').textContent = shortenAddress(authorizedWithdrawer);
            
            if (authorizedWithdrawer === walletPublicKey) {
              authorityBadge.className = 'authority-badge has-authority';
              authorityBadge.innerHTML = '<span class="authority-badge-icon">✓</span><span class="authority-badge-text">You have authority</span>';
            } else {
              authorityBadge.className = 'authority-badge no-authority';
              authorityBadge.innerHTML = '<span class="authority-badge-icon">✗</span><span class="authority-badge-text">You do not have authority</span>';
            }
          }
        }
      } catch (e) {
        console.error('Error checking withdraw authority:', e);
        authorityBadge.className = 'authority-badge';
        authorityBadge.innerHTML = '<span class="authority-badge-icon">⚠️</span><span class="authority-badge-text">Error checking authority</span>';
      }
    }

    // Withdraw XNT Modal State
    let withdrawVoteBalanceLamports = 0;
    let voteAccountWithdrawAuthority = null;
    let userHasWithdrawAuthority = false;

    function initiateWithdraw() {
      if (!currentManageValidator) return;
      if (!walletPublicKey) {
        showWalletRequired('withdraw XNT');
        return;
      }
      
      // Populate modal with validator info
      document.getElementById('withdrawSourceName').textContent = currentManageValidator.name;
      document.getElementById('withdrawSourceAddress').textContent = currentManageValidator.voteAccount;
      document.getElementById('withdrawSourceCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.voteAccount);
      
      // Reset form
      document.getElementById('withdrawAmountInput').value = '';
      document.getElementById('withdrawDestinationInput').value = '';
      document.getElementById('withdrawSummaryAmount').textContent = '0.0000 XNT';
      document.getElementById('withdrawSummaryTotal').textContent = '0.0000 XNT';
      document.getElementById('withdrawAvailableBalance').textContent = 'Loading...';
      document.getElementById('withdrawMessage').style.display = 'none';
      document.getElementById('withdrawConfirmBtn').disabled = true;
      document.getElementById('withdrawConfirmBtn').textContent = 'Withdraw XNT';
      document.getElementById('withdrawConfirmBtn').onclick = confirmWithdrawXnt;
      document.getElementById('withdrawXntCancelBtn').textContent = 'Cancel';
      document.getElementById('withdrawAuthorityWarning').style.display = 'none';
      
      // Fetch vote account data and check authority
      fetchWithdrawModalData();
      
      // Show modal
      document.getElementById('withdrawXntModal').style.display = 'flex';
    }

    function closeWithdrawXntModal() {
      document.getElementById('withdrawXntModal').style.display = 'none';
    }

    async function fetchWithdrawModalData() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result && data.result.value) {
          // Get balance
          withdrawVoteBalanceLamports = data.result.value.lamports;
          
          // Reserve minimum rent-exempt balance (~0.02 XNT = 20000000 lamports)
          const rentExempt = 20000000;
          const availableLamports = Math.max(0, withdrawVoteBalanceLamports - rentExempt);
          const availableXNT = lamportsToXNT(availableLamports);
          
          document.getElementById('withdrawAvailableBalance').textContent = formatNumber(availableXNT, 4);
          
          // Get withdraw authority
          const parsed = data.result.value.data.parsed;
          if (parsed && parsed.info) {
            voteAccountWithdrawAuthority = parsed.info.authorizedWithdrawer;
            
            // Auto-fill destination with withdraw authority
            document.getElementById('withdrawDestinationInput').value = voteAccountWithdrawAuthority;
            
            // Check if user has authority
            if (voteAccountWithdrawAuthority === walletPublicKey) {
              userHasWithdrawAuthority = true;
              document.getElementById('withdrawAuthorityWarning').style.display = 'none';
              document.getElementById('withdrawConfirmBtn').disabled = false;
            } else {
              userHasWithdrawAuthority = false;
              document.getElementById('withdrawAuthorityWarning').style.display = 'flex';
              document.getElementById('withdrawConfirmBtn').disabled = true;
            }
          }
        } else {
          document.getElementById('withdrawAvailableBalance').textContent = '0.0000';
          withdrawVoteBalanceLamports = 0;
        }
      } catch (e) {
        console.error('Error fetching vote account data:', e);
        document.getElementById('withdrawAvailableBalance').textContent = 'Error';
        withdrawVoteBalanceLamports = 0;
      }
    }

    function setWithdrawAmount(percentage) {
      // Reserve minimum rent-exempt balance
      const rentExempt = 20000000;
      const availableLamports = Math.max(0, withdrawVoteBalanceLamports - rentExempt);
      
      if (availableLamports <= 0) return;
      
      const amountLamports = Math.floor(availableLamports * (percentage / 100));
      const amount = lamportsToXNT(amountLamports);
      
      document.getElementById('withdrawAmountInput').value = amount.toFixed(4);
      updateWithdrawSummary();
    }

    function updateWithdrawSummary() {
      const input = document.getElementById('withdrawAmountInput');
      const amount = parseFloat(input.value) || 0;
      const fee = 0.000005; // Estimated network fee
      const received = Math.max(0, amount - fee);
      
      document.getElementById('withdrawSummaryAmount').textContent = formatNumber(amount, 4) + ' XNT';
      document.getElementById('withdrawSummaryTotal').textContent = formatNumber(received, 6) + ' XNT';
    }

    async function confirmWithdrawXnt() {
      if (!userHasWithdrawAuthority) {
        showWithdrawMessage('You do not have withdraw authority for this vote account.', 'error');
        return;
      }
      
      const amountInput = document.getElementById('withdrawAmountInput');
      const amount = parseFloat(amountInput.value);
      
      if (!amount || amount <= 0) {
        showWithdrawMessage('Please enter a valid amount.', 'error');
        return;
      }
      
      const amountLamports = Math.floor(amount * 1000000000);
      const rentExempt = 20000000;
      const availableLamports = withdrawVoteBalanceLamports - rentExempt;
      
      if (amountLamports > availableLamports) {
        showWithdrawMessage('Amount exceeds available balance (after rent reserve).', 'error');
        return;
      }
      
      const destinationAddress = document.getElementById('withdrawDestinationInput').value.trim();
      
      if (!destinationAddress || !isValidPubkey(destinationAddress)) {
        showWithdrawMessage('Please enter a valid destination address.', 'error');
        return;
      }
      
      // Declared outside try so the catch block can verify the tx on a false expiry
      let connection = null;
      let signature = null;

      try {
        const btn = document.getElementById('withdrawConfirmBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showWithdrawMessage('Preparing withdraw transaction...', 'info');
        
        const { Connection, PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
        
        connection = new Connection(RPC_URL, 'confirmed');
        const voteAccountPubkey = new PublicKey(currentManageValidator.voteAccount);
        const withdrawAuthorityPubkey = new PublicKey(walletPublicKey);
        const destinationPubkey = new PublicKey(destinationAddress);
        
        // Vote Program ID
        const VOTE_PROGRAM_ID = new PublicKey('Vote111111111111111111111111111111111111111');
        
        // Create withdraw instruction data
        // Instruction index 3 = Withdraw, followed by lamports (8 bytes LE)
        const data = new Uint8Array(12);
        const dataView = new DataView(data.buffer);
        dataView.setUint32(0, 3, true); // Withdraw instruction index
        // Write lamports as 64-bit LE with range-safety guard
        writeU64LE(dataView, 4, amountLamports);
        
        // Create the withdraw instruction
        const withdrawInstruction = new TransactionInstruction({
          keys: [
            { pubkey: voteAccountPubkey, isSigner: false, isWritable: true },
            { pubkey: destinationPubkey, isSigner: false, isWritable: true },
            { pubkey: withdrawAuthorityPubkey, isSigner: true, isWritable: false }
          ],
          programId: VOTE_PROGRAM_ID,
          data: data
        });
        
        // Create transaction
        const transaction = new Transaction().add(withdrawInstruction);
        
        // Get recent blockhash (use 'confirmed' for the full ~150-block validity
        // window — 'finalized' is already ~30+ slots old and shrinks the window)
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = withdrawAuthorityPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showWithdrawMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send
        if (connectedWallet && connectedWallet.provider) {
          
          // Try signAndSendTransaction first
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showWithdrawMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          // Wait for confirmation (robust: re-checks the signature on-chain a
          // few times on a "block height exceeded"/expired timeout before
          // reporting failure — same helper the rest of the app uses).
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeWithdrawXntModal;
          btn.disabled = false;
          document.getElementById('withdrawXntCancelBtn').textContent = 'Close';
          showWithdrawMessage(`Withdrawal confirmed! Signature: ${signature.slice(0, 16)}...`, 'success', signature);
          
          // Refresh balances (but don't auto-close modal)
          setTimeout(() => {
            fetchManageValidatorData(currentManageValidator.voteAccount);
            fetchWithdrawModalData();
          }, 2000);
          
        } else {
          throw new Error('Wallet not connected properly');
        }
        
      } catch (e) {
        console.error('Withdraw transaction error:', e);
        
        const btn = document.getElementById('withdrawConfirmBtn');

        // confirmWithFallback already re-checks the signature on-chain before
        // giving up, and flags a genuine confirmation timeout via
        // isUnconfirmedTimeout. Treat that (or any raw expiry text) as "may
        // still have landed" rather than a hard failure.
        const looksExpired = e.isUnconfirmedTimeout || (e.message && (
          e.message.includes('block height exceeded') ||
          e.message.includes('expired') ||
          e.message.includes('TransactionExpired')
        ));

        btn.disabled = false;
        btn.textContent = 'Withdraw XNT';
        
        if (e.message && (e.message.includes('User rejected') || e.message.includes('rejected'))) {
          showWithdrawMessage('Transaction cancelled by user.', 'error');
        } else if (e.message && e.message.includes('Plugin Closed')) {
          showWithdrawMessage('Wallet closed unexpectedly. Please try again.', 'error');
        } else if (looksExpired) {
          showWithdrawMessage('Could not confirm in time. Your withdrawal may still have gone through — please check your balance before retrying.', 'error', signature);
        } else {
          showWithdrawMessage(`Transaction failed: ${e.message || 'Unknown error'}`, 'error');
        }
      }
    }

    function showWithdrawMessage(message, type, signature) {
      renderTxMessage('withdrawMessage', message, type, signature);
    }

    // Change Commission Modal State
    let currentCommission = 0;
    let userHasCommissionAuthority = false;

    function initiateChangeCommission() {
      if (!currentManageValidator) return;
      if (!walletPublicKey) {
        showWalletRequired('change commission');
        return;
      }
      
      // Populate modal
      document.getElementById('commissionValidatorName').textContent = currentManageValidator.name;
      document.getElementById('commissionVoteAddress').textContent = currentManageValidator.voteAccount;
      document.getElementById('commissionVoteCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.voteAccount);
      document.getElementById('commissionCurrentValue').textContent = currentManageValidator.commission;
      currentCommission = currentManageValidator.commission;
      
      // Reset form
      document.getElementById('commissionNewInput').value = '';
      document.getElementById('commissionMessage').style.display = 'none';
      document.getElementById('commissionConfirmBtn').disabled = true;
      document.getElementById('commissionConfirmBtn').textContent = 'Update Commission';
      document.getElementById('commissionConfirmBtn').onclick = confirmChangeCommission;
      document.getElementById('commissionCancelBtn').textContent = 'Cancel';
      document.getElementById('commissionAuthorityWarning').style.display = 'none';
      
      // Check authority
      checkCommissionAuthority();
      
      // Show modal
      document.getElementById('commissionModal').style.display = 'flex';
    }

    function closeCommissionModal() {
      document.getElementById('commissionModal').style.display = 'none';
    }

    async function checkCommissionAuthority() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result && data.result.value) {
          const parsed = data.result.value.data.parsed;
          if (parsed && parsed.info) {
            // The authorized withdrawer can also change commission
            const authorizedWithdrawer = parsed.info.authorizedWithdrawer;
            
            if (authorizedWithdrawer === walletPublicKey) {
              userHasCommissionAuthority = true;
              document.getElementById('commissionAuthorityWarning').style.display = 'none';
              document.getElementById('commissionConfirmBtn').disabled = false;
            } else {
              userHasCommissionAuthority = false;
              document.getElementById('commissionAuthorityWarning').style.display = 'flex';
              document.getElementById('commissionConfirmBtn').disabled = true;
            }
          }
        }
      } catch (e) {
        console.error('Error checking commission authority:', e);
        userHasCommissionAuthority = false;
        document.getElementById('commissionConfirmBtn').disabled = true;
      }
    }

    async function confirmChangeCommission() {
      if (!userHasCommissionAuthority) {
        showCommissionMessage('You do not have authority to change commission.', 'error');
        return;
      }
      
      const newCommission = parseInt(document.getElementById('commissionNewInput').value);
      
      if (isNaN(newCommission) || newCommission < 0 || newCommission > 100) {
        showCommissionMessage('Please enter a valid commission rate (0-100).', 'error');
        return;
      }
      
      if (newCommission === currentCommission) {
        showCommissionMessage('New commission is the same as current commission.', 'error');
        return;
      }
      
      try {
        const btn = document.getElementById('commissionConfirmBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showCommissionMessage('Preparing commission update transaction...', 'info');
        
        const { Connection, PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const voteAccountPubkey = new PublicKey(currentManageValidator.voteAccount);
        const authorityPubkey = new PublicKey(walletPublicKey);
        
        // Vote Program ID
        const VOTE_PROGRAM_ID = new PublicKey('Vote111111111111111111111111111111111111111');
        
        // Create update commission instruction data
        // Instruction index 5 = UpdateCommission, followed by new commission (1 byte)
        const data = new Uint8Array(5);
        const dataView = new DataView(data.buffer);
        dataView.setUint32(0, 5, true); // UpdateCommission instruction index
        data[4] = newCommission; // New commission percentage (1 byte)
        
        // Create the update commission instruction
        const updateCommissionInstruction = new TransactionInstruction({
          keys: [
            { pubkey: voteAccountPubkey, isSigner: false, isWritable: true },
            { pubkey: authorityPubkey, isSigner: true, isWritable: false }
          ],
          programId: VOTE_PROGRAM_ID,
          data: data
        });
        
        // Create transaction
        const transaction = new Transaction().add(updateCommissionInstruction);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorityPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showCommissionMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send using wallet
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          // Try signAndSendTransaction first
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showCommissionMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          // Wait for confirmation
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeCommissionModal;
          btn.disabled = false;
          document.getElementById('commissionCancelBtn').textContent = 'Close';
          showCommissionMessage(`Commission updated to ${newCommission}%! Signature: ${signature.slice(0, 16)}...`, 'success', signature);
          
          // Update the local state
          currentManageValidator.commission = newCommission;
          document.getElementById('selectedCommission').textContent = newCommission + '%';
          document.getElementById('commissionCurrentValue').textContent = newCommission;
          currentCommission = newCommission;
          
        } else {
          throw new Error('Wallet not connected properly');
        }
        
      } catch (e) {
        console.error('Commission update error:', e);
        
        const btn = document.getElementById('commissionConfirmBtn');
        btn.disabled = false;
        btn.textContent = 'Update Commission';
        
        if (e.message && (e.message.includes('User rejected') || e.message.includes('rejected'))) {
          showCommissionMessage('Transaction cancelled by user.', 'error');
        } else if (e.message && (e.message.includes('Plugin Closed') || e.message.includes('simulation') || e.message.includes('0x0'))) {
          showCommissionMessage('Transaction failed. Note: Commission can only be changed once per epoch. If you recently changed commission, please wait until the next epoch.', 'error');
        } else {
          showCommissionMessage(`Transaction failed: ${e.message || 'Unknown error'}. Note: Commission can only be changed once per epoch.`, 'error');
        }
      }
    }

    function showCommissionMessage(message, type, signature) {
      renderTxMessage('commissionMessage', message, type, signature);
    }

    // Update Identity Modal State
    let userHasIdentityAuthority = false;

    function initiateUpdateIdentity() {
      if (!currentManageValidator) return;
      if (!walletPublicKey) {
        showWalletRequired('update identity');
        return;
      }
      
      // Populate modal
      document.getElementById('identityCurrentName').textContent = currentManageValidator.name;
      document.getElementById('identityAccountAddress').textContent = currentManageValidator.identityPubkey || 'Unknown';
      if (currentManageValidator.identityPubkey) {
        document.getElementById('identityAccountCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.identityPubkey);
      }
      
      // Pre-fill with current values if available
      document.getElementById('identityNameInput').value = currentManageValidator.name || '';
      document.getElementById('identityWebsiteInput').value = '';
      document.getElementById('identityIconInput').value = currentManageValidator.iconUrl || '';
      
      // Reset state
      document.getElementById('identityMessage').style.display = 'none';
      document.getElementById('identityConfirmBtn').disabled = true;
      document.getElementById('identityConfirmBtn').textContent = 'Update Identity';
      document.getElementById('identityConfirmBtn').onclick = confirmUpdateIdentity;
      document.getElementById('identityCancelBtn').textContent = 'Cancel';
      document.getElementById('identityAuthorityWarning').style.display = 'none';
      document.getElementById('iconPreviewSection').style.display = 'none';
      
      // Check if connected wallet is the identity
      checkIdentityAuthority();
      
      // Show modal
      document.getElementById('identityModal').style.display = 'flex';
      
      // Try to load current identity info
      loadCurrentIdentityInfo();
    }

    function closeIdentityModal() {
      document.getElementById('identityModal').style.display = 'none';
    }

    function checkIdentityAuthority() {
      const identityPubkey = currentManageValidator.identityPubkey;
      
      if (identityPubkey && identityPubkey === walletPublicKey) {
        userHasIdentityAuthority = true;
        document.getElementById('identityAuthorityWarning').style.display = 'none';
        document.getElementById('identityConfirmBtn').disabled = false;
      } else {
        userHasIdentityAuthority = false;
        document.getElementById('identityAuthorityWarning').style.display = 'flex';
        document.getElementById('identityConfirmBtn').disabled = true;
      }
    }

    async function loadCurrentIdentityInfo() {
      if (!currentManageValidator.identityPubkey) return;
      
      try {
        // Try to fetch existing validator info
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.identityPubkey, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        // The identity info is stored separately, this just confirms the account exists
      } catch (e) {
        console.log('Could not load current identity info:', e);
      }
    }

    function previewIcon() {
      const iconUrl = document.getElementById('identityIconInput').value.trim();
      const previewSection = document.getElementById('iconPreviewSection');
      const previewImg = document.getElementById('iconPreviewImg');
      
      if (iconUrl && iconUrl.startsWith('http')) {
        previewImg.src = iconUrl;
        previewSection.style.display = 'block';
      } else {
        previewSection.style.display = 'none';
      }
    }

    function hideIconPreview() {
      document.getElementById('iconPreviewSection').style.display = 'none';
    }

    async function confirmUpdateIdentity() {
      if (!userHasIdentityAuthority) {
        showIdentityMessage('You do not have authority to update this validator\'s identity.', 'error');
        return;
      }
      
      const validatorName = document.getElementById('identityNameInput').value.trim();
      const website = document.getElementById('identityWebsiteInput').value.trim();
      const iconUrl = document.getElementById('identityIconInput').value.trim();
      
      if (!validatorName) {
        showIdentityMessage('Please enter a validator name.', 'error');
        return;
      }
      
      try {
        const btn = document.getElementById('identityConfirmBtn');
        btn.disabled = true;
        btn.textContent = 'Preparing Transaction...';
        
        showIdentityMessage('Preparing validator info update...', 'info');
        
        const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } = solanaWeb3;
        
        const connection = new Connection(RPC_URL, 'confirmed');
        const identityPubkey = new PublicKey(walletPublicKey);
        
        // Config Program ID (used for validator info)
        const CONFIG_PROGRAM_ID = new PublicKey('Config1111111111111111111111111111111111111');
        
        // Derive the validator info account address
        // The validator info account is a PDA derived from the identity pubkey
        const validatorInfoSeed = 'validator-info';
        const [validatorInfoAccount] = await PublicKey.findProgramAddress(
          [new TextEncoder().encode(validatorInfoSeed), identityPubkey.toBytes()],
          CONFIG_PROGRAM_ID
        );
        
        // Build the validator info JSON
        const validatorInfo = {
          name: validatorName
        };
        if (website) validatorInfo.website = website;
        if (iconUrl) validatorInfo.iconUrl = iconUrl;
        
        const infoString = JSON.stringify(validatorInfo);
        const infoBytes = new TextEncoder().encode(infoString);
        
        // Check if account exists
        const accountInfo = await connection.getAccountInfo(validatorInfoAccount);
        
        let transaction;
        
        if (!accountInfo) {
          // Account doesn't exist, need to create it
          // This is more complex - for now we'll show a message
          showIdentityMessage('Validator info account not found. Please use CLI: solana validator-info publish "' + validatorName + '"', 'info');
          btn.disabled = false;
          btn.textContent = 'Update Identity';
          return;
        }
        
        // Build the config data instruction
        // Config instruction: write data starting at offset
        const configKeys = [
          { pubkey: validatorInfoAccount, isSigner: false, isWritable: true },
          { pubkey: identityPubkey, isSigner: true, isWritable: false }
        ];
        
        // The config program expects specific data format
        // For validator-info, we need to use the proper serialization
        
        // Create instruction data for config program
        // This is a simplified version - actual validator-info uses borsh serialization
        const instructionData = new Uint8Array(4 + infoBytes.length);
        const dataView = new DataView(instructionData.buffer);
        dataView.setUint32(0, infoBytes.length, true); // Length prefix
        instructionData.set(infoBytes, 4);
        
        const updateInstruction = new TransactionInstruction({
          keys: configKeys,
          programId: CONFIG_PROGRAM_ID,
          data: instructionData
        });
        
        transaction = new Transaction().add(updateInstruction);
        
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = identityPubkey;
        
        btn.textContent = 'Awaiting Wallet Approval...';
        showIdentityMessage('Please approve the transaction in your wallet...', 'info');
        
        // Sign and send
        if (connectedWallet && connectedWallet.provider) {
          let signature;
          
          signature = await signSendTx(connection, transaction);
          
          btn.textContent = 'Confirming...';
          showIdentityMessage('Transaction sent! Waiting for confirmation...', 'info');
          
          // Wait for confirmation
          await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
          
          btn.textContent = 'Success!';
          btn.onclick = closeIdentityModal;
          btn.disabled = false;
          document.getElementById('identityCancelBtn').textContent = 'Close';
          showIdentityMessage(`Identity updated! Signature: ${signature.slice(0, 16)}...`, 'success', signature);
          
          // Update local state
          currentManageValidator.name = validatorName;
          if (iconUrl) currentManageValidator.iconUrl = iconUrl;
          document.getElementById('manageValidatorName').textContent = validatorName;
          
        } else {
          throw new Error('Wallet not connected properly');
        }
        
      } catch (e) {
        console.error('Identity update error:', e);
        
        const btn = document.getElementById('identityConfirmBtn');
        btn.disabled = false;
        btn.textContent = 'Update Identity';
        
        if (e.message && (e.message.includes('User rejected') || e.message.includes('rejected'))) {
          showIdentityMessage('Transaction cancelled by user.', 'error');
        } else if (e.message && e.message.includes('invalid account data')) {
          showIdentityMessage('Unable to update via web interface. Please use CLI: solana validator-info publish "' + document.getElementById('identityNameInput').value + '"', 'error');
        } else {
          showIdentityMessage(`Transaction failed: ${e.message || 'Unknown error'}. Try using CLI: solana validator-info publish`, 'error');
        }
      }
    }

    function showIdentityMessage(message, type, signature) {
      renderTxMessage('identityMessage', message, type, signature);
    }

    // Change Vote Account Authority state
    let voteAuthorityType = 'vote'; // 'vote' or 'withdraw'
    let voteAccountAuthorities = { vote: null, withdraw: null };

    function initiateChangeAuthority() {
      if (!currentManageValidator) return;
      if (!walletPublicKey) {
        showWalletRequired('change authority');
        return;
      }
      
      // Reset state
      voteAuthorityType = 'vote';
      voteAccountAuthorities = { vote: null, withdraw: null };
      
      // Populate modal
      document.getElementById('changeVoteValidatorName').textContent = currentManageValidator.name;
      document.getElementById('changeVoteAccountAddress').textContent = shortenAddress(currentManageValidator.voteAccount);
      document.getElementById('changeVoteAccountCopyBtn').innerHTML = getCopyButtonHtml(currentManageValidator.voteAccount);
      
      // Reset form
      document.getElementById('newVoteAuthorityInput').value = '';
      document.getElementById('changeVoteAuthorityMessage').style.display = 'none';
      document.getElementById('changeVoteAuthorityBtn').disabled = true;
      document.getElementById('changeVoteAuthorityBtn').textContent = 'Change Authority';
      document.getElementById('changeVoteAuthorityBtn').onclick = confirmChangeVoteAuthority;
      document.getElementById('changeVoteAuthorityCancelBtn').textContent = 'Cancel';
      
      // Reset authority type buttons
      document.getElementById('voteAuthorityTypeBtn').classList.add('active');
      document.getElementById('withdrawAuthorityTypeBtn').classList.remove('active');
      
      // Fetch vote account authorities
      fetchVoteAccountAuthorities();
      
      // Show modal
      document.getElementById('changeVoteAuthorityModal').style.display = 'flex';
    }

    function closeChangeVoteAuthorityModal() {
      document.getElementById('changeVoteAuthorityModal').style.display = 'none';
    }

    async function fetchVoteAccountAuthorities() {
      try {
        document.getElementById('currentVoteAuthority').textContent = 'Loading...';
        
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [currentManageValidator.voteAccount, { encoding: 'jsonParsed' }]
          })
        });
        
        const data = await response.json();
        
        if (data.result && data.result.value) {
          const voteData = data.result.value.data.parsed.info;
          voteAccountAuthorities.vote = voteData.authorizedVoters?.[0]?.authorizedVoter || voteData.authorizedVoter;
          voteAccountAuthorities.withdraw = voteData.authorizedWithdrawer;
          
          // Update display based on selected type
          updateVoteAuthorityDisplay();
        } else {
          document.getElementById('currentVoteAuthority').textContent = 'Unable to fetch';
        }
      } catch (e) {
        console.error('Error fetching vote account authorities:', e);
        document.getElementById('currentVoteAuthority').textContent = 'Error loading';
      }
    }

    function selectVoteAuthorityType(type) {
      voteAuthorityType = type;
      
      // Update button states
      document.getElementById('voteAuthorityTypeBtn').classList.toggle('active', type === 'vote');
      document.getElementById('withdrawAuthorityTypeBtn').classList.toggle('active', type === 'withdraw');
      
      // Update labels
      updateVoteAuthorityDisplay();
      
      // Re-validate input
      validateVoteAuthorityInput();
    }

    function updateVoteAuthorityDisplay() {
      const currentAuthority = voteAuthorityType === 'vote' ? voteAccountAuthorities.vote : voteAccountAuthorities.withdraw;
      const typeLabel = voteAuthorityType === 'vote' ? 'Vote' : 'Withdraw';
      
      document.getElementById('currentVoteAuthorityLabel').textContent = `Current ${typeLabel} Authority:`;
      document.getElementById('newVoteAuthorityLabel').textContent = `New ${typeLabel} Authority:`;
      
      if (currentAuthority) {
        document.getElementById('currentVoteAuthority').textContent = shortenAddress(currentAuthority);
        document.getElementById('currentVoteAuthorityCopyBtn').innerHTML = getCopyButtonHtml(currentAuthority);
        
        // Check if wallet has authority
        const hasAuthority = currentAuthority === walletPublicKey;
        const warning = document.getElementById('voteAuthorityWarning');
        
        if (!hasAuthority) {
          warning.style.display = 'flex';
          document.getElementById('voteAuthorityWarningText').textContent = 
            `Your connected wallet is not the current ${typeLabel.toLowerCase()} authority for this vote account.`;
        } else {
          warning.style.display = 'none';
        }
      } else {
        document.getElementById('currentVoteAuthority').textContent = 'Loading...';
        document.getElementById('currentVoteAuthorityCopyBtn').innerHTML = '';
      }
    }

    function useWalletForVoteAuthority() {
      if (walletPublicKey) {
        document.getElementById('newVoteAuthorityInput').value = walletPublicKey;
        validateVoteAuthorityInput();
      }
    }

    function validateVoteAuthorityInput() {
      const input = document.getElementById('newVoteAuthorityInput').value.trim();
      const btn = document.getElementById('changeVoteAuthorityBtn');
      const currentAuthority = voteAuthorityType === 'vote' ? voteAccountAuthorities.vote : voteAccountAuthorities.withdraw;
      const hasAuthority = currentAuthority === walletPublicKey;
      
      // Validate: must have authority, input must be a real pubkey, and different from current
      const isValidInput = isValidPubkey(input);
      const isDifferent = input !== currentAuthority;
      
      btn.disabled = !(hasAuthority && isValidInput && isDifferent);
    }

    function showChangeVoteAuthorityMessage(message, type, signature) {
      renderTxMessage('changeVoteAuthorityMessage', message, type, signature);
    }

    async function confirmChangeVoteAuthority() {
      const newAuthority = document.getElementById('newVoteAuthorityInput').value.trim();
      
      if (!newAuthority || !walletPublicKey || !currentManageValidator) return;

      if (!isValidPubkey(newAuthority)) {
        showChangeVoteAuthorityMessage('That is not a valid address. Double-check the public key — this action is irreversible.', 'error');
        return;
      }
      
      // If changing vote authority, show scary confirmation first
      if (voteAuthorityType === 'vote') {
        showVoteAuthorityDangerModal();
        return;
      }
      
      // For withdraw authority, proceed directly
      await executeVoteAuthorityChange(newAuthority);
    }

    function showVoteAuthorityDangerModal() {
      document.getElementById('voteAuthorityConfirmInput').value = '';
      document.getElementById('voteAuthorityDangerBtn').disabled = true;
      document.getElementById('voteAuthorityDangerModal').style.display = 'flex';
    }

    function closeVoteAuthorityDangerModal() {
      document.getElementById('voteAuthorityDangerModal').style.display = 'none';
    }

    function validateVoteAuthorityConfirm() {
      const input = document.getElementById('voteAuthorityConfirmInput').value.trim();
      const btn = document.getElementById('voteAuthorityDangerBtn');
      btn.disabled = input !== 'CHANGE VOTE AUTHORITY';
    }

    async function proceedWithVoteAuthorityChange() {
      closeVoteAuthorityDangerModal();
      const newAuthority = document.getElementById('newVoteAuthorityInput').value.trim();
      await executeVoteAuthorityChange(newAuthority);
    }

    async function executeVoteAuthorityChange(newAuthority) {
      const btn = document.getElementById('changeVoteAuthorityBtn');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      
      try {
        const { PublicKey, VoteProgram, Transaction, Connection } = solanaWeb3;
        const connection = new Connection(RPC_URL, 'confirmed');
        
        const votePubkey = new PublicKey(currentManageValidator.voteAccount);
        const authorizedPubkey = new PublicKey(walletPublicKey);
        const newAuthorizedPubkey = new PublicKey(newAuthority);
        
        let instruction;
        
        if (voteAuthorityType === 'vote') {
          // Change vote authority
          instruction = VoteProgram.authorize({
            votePubkey: votePubkey,
            authorizedPubkey: authorizedPubkey,
            newAuthorizedPubkey: newAuthorizedPubkey,
            voteAuthorizationType: { index: 0 } // 0 = Voter
          });
        } else {
          // Change withdraw authority
          instruction = VoteProgram.authorize({
            votePubkey: votePubkey,
            authorizedPubkey: authorizedPubkey,
            newAuthorizedPubkey: newAuthorizedPubkey,
            voteAuthorizationType: { index: 1 } // 1 = Withdrawer
          });
        }
        
        const transaction = new Transaction().add(instruction);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = authorizedPubkey;
        
        btn.textContent = 'Sign Transaction...';
        showChangeVoteAuthorityMessage('Please approve the transaction in your wallet...', 'info');
        
        let signature;
        signature = await signSendTx(connection, transaction);
        
        btn.textContent = 'Confirming...';
        showChangeVoteAuthorityMessage('Transaction sent! Waiting for confirmation...', 'info');
        
        await confirmWithFallback(connection, signature, blockhash, lastValidBlockHeight, 'confirmed');
        
        const typeLabel = voteAuthorityType === 'vote' ? 'Vote' : 'Withdraw';
        btn.textContent = 'Success!';
        btn.onclick = closeChangeVoteAuthorityModal;
        btn.disabled = false;
        document.getElementById('changeVoteAuthorityCancelBtn').textContent = 'Close';
        showChangeVoteAuthorityMessage(`${typeLabel} authority changed successfully! Signature: ${signature.slice(0, 20)}...`, 'success', signature);
        
        // Refresh authorities display after a delay
        setTimeout(() => {
          fetchVoteAccountAuthorities();
        }, 2000);
        
      } catch (e) {
        console.error('Change vote authority error:', e);
        
        if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
          showChangeVoteAuthorityMessage('Transaction cancelled by user.', 'error');
        } else {
          showChangeVoteAuthorityMessage(`Error: ${e.message || 'Transaction failed'}`, 'error');
        }
        
        btn.disabled = false;
        btn.textContent = 'Change Authority';
      }
    }

    // Event listeners
    document.getElementById('validatorModal').addEventListener('click', function(e) {
      if (e.target === this) closeValidatorList();
    });

    document.getElementById('manageValidatorModal').addEventListener('click', function(e) {
      if (e.target === this) closeManageValidator();
    });

    document.getElementById('searchInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') performSearch();
    });

