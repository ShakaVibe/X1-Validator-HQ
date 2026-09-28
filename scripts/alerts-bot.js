#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// X1 Validator HQ — Telegram alerts bot (F3)
// ---------------------------------------------------------------------------
// Runs inside a GitHub Actions job (.github/workflows/alerts.yml) as a loop:
//
//   getUpdates (long poll, ≤50 s)  → answer /watch /unwatch /list /status /help
//   every CHECK_MS (5 min)         → getEpochInfo + getVoteAccounts + getBlockProduction
//                                     → delinquent / back online / leader-slot skips
//   every SNAP_MS (30 min)         → data/delegation.json + data/terminal.json from the site
//                                     → Delegation Program status / version behind minimum
//
// Subscriptions and the last-seen state of every watched validator live in ONE
// encrypted file in the repo (data/alerts-state.enc, AES-256-GCM, key in the
// ALERTS_STATE_KEY repo secret) — the repo is public and other people's Telegram
// chat ids must not be readable from it. The file is committed only when it
// changes (subscriptions right away, status at most every COMMIT_MIN_MS).
//
// Zero dependencies, Node 20 (global fetch). `require()`-able for the tests:
// scripts/test-alerts-bot.js injects fetch / clock / persist.
//
// Env: TELEGRAM_BOT_TOKEN (required), ALERTS_STATE_KEY (required, 64 hex chars),
//      TELEGRAM_CHAT_ID (optional admin chat: /stats + RPC-down notice),
//      X1_RPC_URL, SITE_URL, ALERTS_STATE_FILE, ALERTS_LOG_LEVEL (debug|info)
// CLI: --minutes N (loop length, default 345)  --once (one check, no polling)
//      --commit (git commit + push the state file when it changes)
//
// PRIVACY: this runs with public logs. Never log chat ids, user names or message
// text — log() only ever prints chatTag() (4 hex chars of a sha256).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULTS = {
  rpcUrl: 'https://rpc.mainnet.x1.xyz',
  siteUrl: 'https://x1valhq.xyz',
  stateFile: 'data/alerts-state.enc',
  checkMs: 5 * 60 * 1000,        // live RPC check cadence
  snapMs: 30 * 60 * 1000,        // site snapshot cadence (files change hourly)
  pollTimeoutS: 50,              // Telegram long-poll wait
  commitMinMs: 10 * 60 * 1000,   // debounce for status-only state commits
  recoveryChecks: 2,             // consecutive clean checks before "back online"
  skipWindowMs: 30 * 60 * 1000,  // coalesce skip alerts per validator
  rpcDownNoticeMs: 30 * 60 * 1000,
  maxWatch: 20,                  // validators per chat
  slotSeconds: 0.37,
  settleSlots: 64,               // ignore the newest slots in getBlockProduction (confirmation lag)
  lamports: 1e9,
  branch: 'main',
};

const CRITERIA = {
  minSelfStake: 'self-stake below the minimum',
  delinquent: 'delinquent',
  maxSkipRate: 'skip rate above the tolerance',
  minVoteCredits: 'vote credits below the threshold',
  minValidatorVersion: 'version below the minimum',
  noVersionInfo: 'no version info in gossip',
  maxCommission: 'commission above the maximum',
  maxTotalStake: 'total stake above the cap',
  maxValidatorStakePct: 'stake share above the cap',
};

const HELP =
  '<b>X1 Validator HQ alerts</b>\n' +
  'I watch validators on the X1 network and message you when something changes:\n' +
  '🔴 delinquent / 🟢 voting again · ⏭ skipped leader slots · 🏛 Delegation Program status · ⬆️ version below the Foundation minimum\n\n' +
  '/watch &lt;name or vote account&gt; … — watch one or more validators\n' +
  '/unwatch &lt;name or vote account&gt; | all\n' +
  '/list — what this chat watches\n' +
  '/status — live check of your validators right now\n' +
  '/help — this text\n\n' +
  'Checks run every 5 minutes; Delegation Program data is refreshed hourly.';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const fmtXnt = (lamports) => { const x = Number(lamports || 0) / DEFAULTS.lamports; return x.toLocaleString('en-US', { maximumFractionDigits: x < 1000 ? 2 : 0 }); };
const pct = (n, d) => (d > 0 ? (100 * n / d) : 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function semver(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function cmpVer(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
function chatTag(chatId) {
  return crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 4);
}
function sameList(a, b) {
  a = (a || []).slice().sort(); b = (b || []).slice().sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// state file (AES-256-GCM)
// ---------------------------------------------------------------------------
const MAGIC = 'X1HQ-ALERTS-v1';
function encryptState(obj, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `${MAGIC}\n${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}\n`;
}
function decryptState(text, keyHex) {
  const lines = String(text).trim().split('\n');
  if (lines[0] !== MAGIC) throw new Error('state file: bad header');
  const raw = Buffer.from(lines.slice(1).join(''), 'base64');
  const key = Buffer.from(keyHex, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}
function emptyState() {
  return { v: 1, offset: 0, chats: {}, seen: {}, meta: {} };
}

// ---------------------------------------------------------------------------
// the bot
// ---------------------------------------------------------------------------
function createBot(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fetchFn = o.fetch || globalThis.fetch;
  const now = o.now || (() => Date.now());
  const log = o.log || ((level, msg) => { if (level !== 'debug' || o.logLevel === 'debug') console.log(`[alerts] ${msg}`); });
  const token = o.token;
  const keyHex = o.key;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex || '')) throw new Error('ALERTS_STATE_KEY must be 64 hex characters (openssl rand -hex 32)');
  const adminChatId = o.adminChatId ? String(o.adminChatId) : null;
  const tg = `https://api.telegram.org/bot${token}`;

  // -- state ---------------------------------------------------------------
  let state = emptyState();
  let dirty = false;          // status-only changes (debounced commit)
  let dirtySubs = false;      // subscription changes (commit right away)
  let lastCommitAt = 0;
  const stats = { started: now(), checks: 0, alerts: 0, rpcErrors: 0, lastCheckOk: 0, lastSnapOk: 0, rpcDownSince: 0, rpcDownNotified: false };

  // live caches (not persisted)
  let live = null;            // { at, epoch, slot, votes: Map vote → {node, commission, delinquent, lastVote, stake}, prod: Map node → [slots, produced], range }
  let snap = null;            // { at, config, cluster, deleg: Map vote → rec, names: Map vote → name, byName: [{name, lower, vote}], nodeToVote: Map }

  function loadState() {
    if (fs.existsSync(o.stateFile)) {
      state = decryptState(fs.readFileSync(o.stateFile, 'utf8'), keyHex);
      if (!state.chats) state.chats = {};
      if (!state.seen) state.seen = {};
      if (!state.meta) state.meta = {};
      log('info', `state loaded: ${Object.keys(state.chats).length} chats, ${Object.keys(state.seen).length} watched validators`);
    } else {
      state = emptyState();
      log('info', 'no state file yet — starting empty');
    }
    return state;
  }
  function pruneSeen() {
    const watched = new Set();
    for (const c of Object.values(state.chats)) for (const v of c.votes) watched.add(v);
    for (const v of Object.keys(state.seen)) if (!watched.has(v)) delete state.seen[v];
  }
  function writeState() {
    pruneSeen();
    fs.mkdirSync(path.dirname(o.stateFile), { recursive: true });
    fs.writeFileSync(o.stateFile, encryptState(state, keyHex));
  }
  async function persistIfNeeded(force) {
    if (!dirty && !dirtySubs) return false;
    if (!force && !dirtySubs && now() - lastCommitAt < o.commitMinMs) return false;
    writeState();
    dirty = false; dirtySubs = false; lastCommitAt = now();
    if (o.persist) await o.persist(o.stateFile);
    else if (o.commit) gitCommit(o.stateFile);
    return true;
  }
  function gitCommit(file) {
    const git = (...a) => execFileSync('git', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    try {
      git('add', file);
      if (git('diff', '--cached', '--name-only').trim() === '') return;
      git('commit', '-m', 'chore: update alerts state [skip ci]');
      for (let i = 1; i <= 5; i++) {
        try { git('pull', '--rebase', 'origin', o.branch); git('push', 'origin', `HEAD:${o.branch}`); log('info', 'state committed + pushed'); return; }
        catch (e) { log('info', `push attempt ${i} failed; retrying`); execFileSync('sleep', ['10']); }
      }
      log('error', 'could not push the state file after 5 attempts');
    } catch (e) {
      log('error', `git: ${String(e.message || e).split('\n')[0]}`);
    }
  }

  // -- telegram ------------------------------------------------------------
  async function tgCall(method, body, timeoutMs = 65000) {
    const res = await fetchFn(`${tg}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* fallthrough */ }
    if (!data) throw new Error(`telegram ${method}: HTTP ${res.status}`);
    return data;
  }
  async function send(chatId, html, extra = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let data;
      try {
        data = await tgCall('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }, 20000);
      } catch (e) {
        log('info', `send to #${chatTag(chatId)} failed (${String(e.message || e).split('\n')[0]}), attempt ${attempt + 1}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (data.ok) return true;
      if (data.error_code === 429) { await sleep(1000 * ((data.parameters && data.parameters.retry_after) || 3)); continue; }
      if (data.error_code === 403 || (data.error_code === 400 && /chat not found|deactivated/i.test(data.description || ''))) {
        // blocked the bot / kicked from the group → forget the chat
        if (state.chats[chatId]) { delete state.chats[chatId]; dirtySubs = true; log('info', `chat #${chatTag(chatId)} gone (${data.error_code}) — subscriptions removed`); }
        return false;
      }
      log('info', `send to #${chatTag(chatId)}: ${data.error_code} ${String(data.description || '').slice(0, 80)}`);
      return false;
    }
    return false;
  }
  async function setCommands() {
    try {
      await tgCall('setMyCommands', { commands: [
        { command: 'watch', description: 'Watch a validator (name or vote account)' },
        { command: 'unwatch', description: 'Stop watching a validator (or "all")' },
        { command: 'list', description: 'Validators this chat watches' },
        { command: 'status', description: 'Live check of your validators' },
        { command: 'help', description: 'What the bot does' },
      ] }, 15000);
    } catch (e) { log('info', `setMyCommands failed: ${String(e.message || e).split('\n')[0]}`); }
  }
  async function pollUpdates() {
    let data;
    try {
      data = await tgCall('getUpdates', { offset: state.offset || 0, timeout: o.pollTimeoutS, allowed_updates: ['message'] });
    } catch (e) {
      log('info', `getUpdates failed: ${String(e.message || e).split('\n')[0]}`);
      await sleep(5000);
      return 0;
    }
    if (!data.ok) { log('info', `getUpdates: ${data.error_code} ${data.description}`); await sleep(5000); return 0; }
    for (const u of data.result || []) {
      state.offset = u.update_id + 1;
      try { await handleMessage(u.message); }
      catch (e) { log('error', `handler: ${String(e.stack || e).split('\n').slice(0, 2).join(' | ')}`); }
    }
    if ((data.result || []).length) dirty = true; // offset moved
    return (data.result || []).length;
  }

  // -- commands ------------------------------------------------------------
  async function handleMessage(m) {
    if (!m || typeof m.text !== 'string' || !m.chat) return;
    const chatId = String(m.chat.id);
    const text = m.text.trim();
    if (!text.startsWith('/')) return;
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.slice(1).replace(/@\w+$/, '').toLowerCase();
    log('debug', `#${chatTag(chatId)} /${cmd} (${args.length} args)`);
    switch (cmd) {
      case 'start':
      case 'help':
        return send(chatId, HELP);
      case 'watch':
        return cmdWatch(chatId, args);
      case 'unwatch':
        return cmdUnwatch(chatId, args);
      case 'list':
        return cmdList(chatId);
      case 'status':
        return cmdStatus(chatId);
      case 'stats':
        if (adminChatId && chatId === adminChatId) return cmdStats(chatId);
        return;
      default:
        if (m.chat.type === 'private') return send(chatId, 'Unknown command. /help lists what I can do.');
    }
  }

  function resolveTarget(term) {
    // returns { vote, name } | { error } | { candidates: [...] }
    const s = term.trim();
    if (!s) return { error: 'empty' };
    if (B58.test(s)) {
      if (live && live.votes.has(s)) return { vote: s, name: nameOf(s) };
      if (snap && snap.names.has(s)) return { vote: s, name: nameOf(s) };
      if (snap && snap.nodeToVote.has(s)) { const v = snap.nodeToVote.get(s); return { vote: v, name: nameOf(v) }; }
      if (!live && !snap) return { vote: s, name: s.slice(0, 8) + '…' }; // no data yet — trust the key
      return { error: `no validator with vote account or identity <code>${esc(s)}</code>` };
    }
    if (!snap) return { error: 'validator names are not loaded yet — try again in a minute, or use the vote account key' };
    const lower = s.toLowerCase();
    const exact = snap.byName.filter((n) => n.lower === lower);
    if (exact.length === 1) return { vote: exact[0].vote, name: exact[0].name };
    const part = snap.byName.filter((n) => n.lower.includes(lower));
    if (part.length === 1) return { vote: part[0].vote, name: part[0].name };
    if (part.length === 0) return { error: `no validator named “${esc(s)}”` };
    return { candidates: part.slice(0, 8) };
  }
  function nameOf(vote) {
    return (snap && snap.names.get(vote)) || `${vote.slice(0, 6)}…${vote.slice(-4)}`;
  }
  function link(vote, label) {
    return `<a href="${o.siteUrl}/#/lookup/${vote}">${esc(label || 'Open in X1 Validator HQ')}</a>`;
  }
  function splitTerms(args) {
    // allow "/watch Shaka_Vibes_1, Shaka_Vibes_2" and quoted names with spaces: "X1 Labs: (node8)"
    const joined = args.join(' ');
    const out = [];
    const re = /"([^"]+)"|'([^']+)'|([^,\s]+)/g;
    let m;
    while ((m = re.exec(joined))) out.push(m[1] || m[2] || m[3]);
    return out;
  }
  async function cmdWatch(chatId, args) {
    const terms = splitTerms(args);
    if (!terms.length) return send(chatId, 'Usage: /watch &lt;name or vote account&gt; — several at once are fine, e.g.\n<code>/watch Shaka_Vibes_1 Shaka_Vibes_2</code>');
    const chat = state.chats[chatId] || (state.chats[chatId] = { votes: [], since: new Date(now()).toISOString() });
    const lines = [];
    for (const t of terms) {
      const r = resolveTarget(t);
      if (r.error) { lines.push(`✗ ${r.error}`); continue; }
      if (r.candidates) { lines.push(`✗ “${esc(t)}” matches several: ${r.candidates.map((c) => esc(c.name)).join(', ')} — be more specific or use the vote account`); continue; }
      if (chat.votes.includes(r.vote)) { lines.push(`• already watching <b>${esc(r.name)}</b>`); continue; }
      if (chat.votes.length >= o.maxWatch) { lines.push(`✗ limit of ${o.maxWatch} validators per chat reached`); break; }
      chat.votes.push(r.vote);
      dirtySubs = true;
      seedSeen(r.vote);
      lines.push(`✓ watching <b>${esc(r.name)}</b> ${statusLine(r.vote)}`);
    }
    if (!chat.votes.length) delete state.chats[chatId];
    await persistIfNeeded(true);
    return send(chatId, lines.join('\n'));
  }
  async function cmdUnwatch(chatId, args) {
    const chat = state.chats[chatId];
    if (!chat || !chat.votes.length) return send(chatId, 'This chat is not watching any validator.');
    const terms = splitTerms(args);
    if (!terms.length) return send(chatId, 'Usage: /unwatch &lt;name or vote account&gt;, or /unwatch all');
    const lines = [];
    if (terms.length === 1 && terms[0].toLowerCase() === 'all') {
      lines.push(`Stopped watching ${chat.votes.length} validator(s).`);
      delete state.chats[chatId];
      dirtySubs = true;
    } else {
      for (const t of terms) {
        let vote = null;
        if (B58.test(t) && chat.votes.includes(t)) vote = t;
        else {
          const lower = t.toLowerCase();
          const hits = chat.votes.filter((v) => nameOf(v).toLowerCase() === lower);
          const parts = hits.length ? hits : chat.votes.filter((v) => nameOf(v).toLowerCase().includes(lower));
          if (parts.length === 1) vote = parts[0];
          else if (parts.length > 1) { lines.push(`✗ “${esc(t)}” matches several of your validators`); continue; }
        }
        if (!vote) { lines.push(`✗ “${esc(t)}” is not on this chat's list`); continue; }
        chat.votes = chat.votes.filter((v) => v !== vote);
        dirtySubs = true;
        lines.push(`✓ stopped watching <b>${esc(nameOf(vote))}</b>`);
      }
      if (!chat.votes.length) delete state.chats[chatId];
    }
    await persistIfNeeded(true);
    return send(chatId, lines.join('\n'));
  }
  async function cmdList(chatId) {
    const chat = state.chats[chatId];
    if (!chat || !chat.votes.length) return send(chatId, 'This chat is not watching any validator. /watch &lt;name&gt; to start.');
    const lines = chat.votes.map((v) => `• <b>${esc(nameOf(v))}</b> ${statusLine(v)}\n  <code>${v}</code>`);
    return send(chatId, `Watching ${chat.votes.length} validator(s):\n` + lines.join('\n'));
  }
  async function cmdStatus(chatId) {
    const chat = state.chats[chatId];
    if (!chat || !chat.votes.length) return send(chatId, 'This chat is not watching any validator. /watch &lt;name&gt; to start.');
    const ok = await refreshLive(false);
    if (!ok && !live) return send(chatId, 'The RPC is not answering right now — try again in a few minutes.');
    const age = live ? fmtDuration(now() - live.at) : '?';
    const lines = chat.votes.map((v) => `${statusLine(v, true)}`);
    return send(chatId, `<b>Status</b> (epoch ${live ? live.epoch : '?'}, checked ${age === '0 min' ? 'just now' : age + ' ago'})\n` + lines.join('\n'));
  }
  async function cmdStats(chatId) {
    const chats = Object.keys(state.chats).length;
    const watched = new Set(); for (const c of Object.values(state.chats)) for (const v of c.votes) watched.add(v);
    const up = fmtDuration(now() - stats.started);
    return send(chatId,
      `<b>Alerts bot</b> — up ${up}\n` +
      `${chats} chat(s) · ${watched.size} watched validator(s) · ${stats.alerts} alert(s) this run\n` +
      `checks ${stats.checks} · RPC errors ${stats.rpcErrors} · last check ${stats.lastCheckOk ? fmtDuration(now() - stats.lastCheckOk) + ' ago' : 'never'} · last snapshot ${stats.lastSnapOk ? fmtDuration(now() - stats.lastSnapOk) + ' ago' : 'never'}`);
  }

  // -- status text -----------------------------------------------------------
  function statusLine(vote, full) {
    const lv = live && live.votes.get(vote);
    const dg = snap && snap.deleg.get(vote);
    const parts = [];
    if (lv) {
      parts.push(lv.delinquent ? '🔴 delinquent' : '🟢 voting');
      if (full) {
        const behind = Math.max(0, (live.slot || 0) - (lv.lastVote || 0));
        if (lv.delinquent) parts.push(`${fmtInt(behind)} slots behind`);
        parts.push(`${lv.commission}% commission`);
        const p = live.prod.get(lv.node);
        if (p) parts.push(p[0] ? `skipped ${p[0] - p[1]}/${p[0]} leader slots` : 'no leader slots yet');
      }
    } else if (live) parts.push('⚪ not in the vote account list');
    if (full) {
      const ver = dg ? dg.ver : null;
      const min = snap && snap.config.minValidatorVersion;
      if (ver && min) {
        const c = cmpVer(ver, min);
        parts.push(c === -1 ? `⬆️ v${esc(ver)} (min ${esc(min)})` : `v${esc(ver)}`);
      }
      if (dg) parts.push(delegShort(dg));
      else if (snap) parts.push('not enrolled in the Delegation Program');
    }
    const head = full ? `<b>${esc(nameOf(vote))}</b>: ` : '';
    return parts.length ? `${head}${parts.join(' · ')}${full ? '\n' + link(vote) : ''}` : (full ? head + 'no data yet' : '');
  }
  function delegShort(dg) {
    if (!dg) return '';
    const st = dg.st || '?';
    if (st === 'Approved' && !(dg.fc || []).length) return `🏛 Approved · ${fmtXnt(dg.ds)} XNT delegated`;
    return `🏛 ${esc(st)}${(dg.fc || []).length ? ' · failing: ' + dg.fc.map(criterionText.bind(null, dg)).map(esc).join(', ') : ''}`;
  }
  function criterionText(dg, key) {
    const cfg = (snap && snap.config) || {};
    switch (key) {
      case 'minSelfStake': return `self-stake ${fmtXnt(dg.ss)} XNT < ${fmtXnt(cfg.minSelfStake)} XNT minimum`;
      case 'minValidatorVersion': return `version ${dg.ver || '?'} < ${cfg.minValidatorVersion || 'minimum'}`;
      case 'maxCommission': return `commission ${dg.cm}% > ${cfg.maxCommissionPercent}% maximum`;
      default: return CRITERIA[key] || key;
    }
  }

  // -- data: RPC ---------------------------------------------------------------
  let rpcId = 0;
  async function rpc(method, params = [], retries = 2) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchFn(o.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
          signal: AbortSignal.timeout(45000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(`${method}: ${data.error.message}`);
        return data.result;
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
  }
  async function refreshLive(force) {
    if (!force && live && now() - live.at < 60000) return true; // /status right after a tick reuses it
    try {
      const epochInfo = await rpc('getEpochInfo', [{ commitment: 'confirmed' }]);
      // Block production is read for the settled part of the epoch only: the
      // last SETTLE_SLOTS before the tip can still show a produced block as
      // "missing" at confirmed commitment, which would count as a phantom skip.
      const epochFirst = epochInfo.absoluteSlot - epochInfo.slotIndex;
      const lastSettled = epochInfo.absoluteSlot - o.settleSlots;
      const [va, bp] = await Promise.all([
        rpc('getVoteAccounts', [{ commitment: 'confirmed' }]),
        lastSettled >= epochFirst
          ? rpc('getBlockProduction', [{ commitment: 'confirmed', range: { firstSlot: epochFirst, lastSlot: lastSettled } }])
          : Promise.resolve({ value: { byIdentity: {}, range: { firstSlot: epochFirst, lastSlot: epochFirst } } }),
      ]);
      const votes = new Map();
      for (const v of va.current || []) votes.set(v.votePubkey, { node: v.nodePubkey, commission: v.commission, delinquent: false, lastVote: v.lastVote, stake: v.activatedStake });
      for (const v of va.delinquent || []) votes.set(v.votePubkey, { node: v.nodePubkey, commission: v.commission, delinquent: true, lastVote: v.lastVote, stake: v.activatedStake });
      const prod = new Map();
      const by = (bp && bp.value && bp.value.byIdentity) || {};
      for (const [id, arr] of Object.entries(by)) prod.set(id, arr);
      live = { at: now(), epoch: epochInfo.epoch, slot: epochInfo.absoluteSlot, votes, prod, range: (bp && bp.value && bp.value.range) || null };
      stats.lastCheckOk = now();
      if (stats.rpcDownSince) { log('info', `RPC back after ${fmtDuration(now() - stats.rpcDownSince)}`); stats.rpcDownSince = 0; stats.rpcDownNotified = false; }
      return true;
    } catch (e) {
      stats.rpcErrors++;
      if (!stats.rpcDownSince) stats.rpcDownSince = now();
      log('info', `RPC check failed: ${String(e.message || e).split('\n')[0]}`);
      if (adminChatId && !stats.rpcDownNotified && now() - stats.rpcDownSince >= o.rpcDownNoticeMs) {
        stats.rpcDownNotified = true;
        await send(adminChatId, `⚠️ alerts bot: the RPC has not answered for ${fmtDuration(now() - stats.rpcDownSince)} — no delinquency/skip checks meanwhile.`);
      }
      return false;
    }
  }

  // -- data: site snapshots ----------------------------------------------------
  async function getJson(url) {
    const res = await fetchFn(`${url}${url.includes('?') ? '&' : '?'}t=${now()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  async function refreshSnap(force) {
    if (!force && snap && now() - snap.at < o.snapMs) return true;
    try {
      const [dl, tm] = await Promise.all([getJson(`${o.siteUrl}/data/delegation.json`), getJson(`${o.siteUrl}/data/terminal.json`)]);
      const names = new Map(), nodeToVote = new Map(), byName = [];
      const vf = tm.validatorFields || [];
      const iVote = vf.indexOf('votePubkey'), iNode = vf.indexOf('nodePubkey'), iName = vf.indexOf('name');
      for (const row of tm.validators || []) {
        const vote = row[iVote], node = row[iNode], name = (iName >= 0 && row[iName]) || '';
        if (!vote) continue;
        if (node) nodeToVote.set(node, vote);
        if (name) { names.set(vote, name); byName.push({ name, lower: name.toLowerCase(), vote }); }
      }
      const deleg = new Map();
      for (const [vote, rec] of Object.entries(dl.validators || {})) {
        deleg.set(vote, rec);
        if (rec.name && !names.has(vote)) { names.set(vote, rec.name); byName.push({ name: rec.name, lower: rec.name.toLowerCase(), vote }); }
        if (rec.id && !nodeToVote.has(rec.id)) nodeToVote.set(rec.id, vote);
      }
      snap = { at: now(), generatedAt: dl.generatedAt, config: dl.config || {}, cluster: dl.cluster || {}, deleg, names, byName, nodeToVote };
      stats.lastSnapOk = now();
      log('debug', `snapshots loaded: ${deleg.size} delegation records, ${names.size} names, min version ${snap.config.minValidatorVersion}`);
      return true;
    } catch (e) {
      log('info', `snapshot fetch failed: ${String(e.message || e).split('\n')[0]}`);
      return false;
    }
  }

  // -- the checks ---------------------------------------------------------------
  function watchers(vote) {
    return Object.entries(state.chats).filter(([, c]) => c.votes.includes(vote)).map(([id]) => id);
  }
  function seedSeen(vote) {
    // first sighting: record what we see now so we alert on CHANGES, not on the current state
    const s = state.seen[vote] || (state.seen[vote] = {});
    const lv = live && live.votes.get(vote);
    if (lv && s.d === undefined) { s.d = lv.delinquent; s.dSince = now(); s.clean = 0; }
    if (lv && live.prod.has(lv.node) && !s.lead) { const p = live.prod.get(lv.node); s.lead = { first: live.range ? live.range.firstSlot : 0, skipped: p[0] - p[1] }; }
    const dg = snap && snap.deleg.get(vote);
    if (snap && s.st === undefined) { s.st = dg ? (dg.st || '?') : 'none'; s.fc = dg ? (dg.fc || []).slice() : []; }
    if (snap && s.behind === undefined) { const c = dg ? cmpVer(dg.ver, snap.config.minValidatorVersion) : null; s.behind = c === null ? null : c === -1; s.minVer = snap.config.minValidatorVersion || null; }
    dirty = true;
  }
  async function alertAll(vote, html) {
    const targets = watchers(vote);
    for (const chatId of targets) { if (await send(chatId, html)) stats.alerts++; }
    return targets.length;
  }

  async function checkLive() {
    stats.checks++;
    const watched = new Set(); for (const c of Object.values(state.chats)) for (const v of c.votes) watched.add(v);
    for (const vote of watched) {
      const s = state.seen[vote] || (state.seen[vote] = {});
      const lv = live.votes.get(vote);
      const name = nameOf(vote);
      if (!lv) {
        if (s.d !== undefined && !s.missing) {
          s.missing = true; dirty = true;
          await alertAll(vote, `⚪ <b>${esc(name)}</b> is no longer in the network's vote account list (closed or never voted this epoch).\n${link(vote)}`);
        }
        continue;
      }
      if (s.missing) { s.missing = false; dirty = true; }
      // -- delinquency
      if (s.d === undefined) { s.d = lv.delinquent; s.dSince = now(); s.clean = 0; dirty = true; }
      else if (lv.delinquent && !s.d) {
        s.d = true; s.dSince = now(); s.clean = 0; dirty = true;
        const behind = Math.max(0, (live.slot || 0) - (lv.lastVote || 0));
        await alertAll(vote,
          `🔴 <b>${esc(name)}</b> is <b>delinquent</b>\n` +
          `Last vote: slot ${fmtInt(lv.lastVote)} · ${fmtInt(behind)} slots behind (~${fmtDuration(behind * o.slotSeconds * 1000)}) · epoch ${live.epoch}\n` +
          link(vote));
      } else if (lv.delinquent && s.d) {
        if (s.clean) { s.clean = 0; dirty = true; }
      } else if (!lv.delinquent && s.d) {
        s.clean = (s.clean || 0) + 1; dirty = true;
        if (s.clean >= o.recoveryChecks) {
          const down = now() - (s.dSince || now());
          s.d = false; s.clean = 0; s.dSince = now();
          await alertAll(vote, `🟢 <b>${esc(name)}</b> is voting again (was delinquent for ~${fmtDuration(down)}).\n${link(vote)}`);
        }
      }
      // -- leader-slot skips (coalesced per skipWindowMs)
      const p = live.prod.get(lv.node);
      const first = live.range ? live.range.firstSlot : 0;
      if (p) {
        const skipped = Math.max(0, p[0] - p[1]);
        if (!s.lead) { s.lead = { first, skipped }; dirty = true; }               // first sighting: baseline, no alert for old skips
        else if (s.lead.first !== first) { s.lead = { first, skipped: 0 }; dirty = true; } // new epoch: count from zero
        if (skipped > s.lead.skipped) {
          s.pending = (s.pending || 0) + (skipped - s.lead.skipped);
          s.lead.skipped = skipped; dirty = true;
        }
        if (s.pending && now() - (s.skipAt || 0) >= o.skipWindowMs) {
          const n = s.pending; s.pending = 0; s.skipAt = now(); dirty = true;
          const net = snap && snap.cluster && typeof snap.cluster.skipRatePct === 'number' ? ` · network avg ${snap.cluster.skipRatePct.toFixed(2)}%` : '';
          await alertAll(vote,
            `⏭ <b>${esc(name)}</b> skipped <b>${n} leader slot${n === 1 ? '' : 's'}</b> in the last ${fmtDuration(o.skipWindowMs)}\n` +
            `Epoch ${live.epoch} so far: ${skipped} of ${p[0]} leader slots skipped (${pct(skipped, p[0])})${net}\n` +
            link(vote));
        }
      }
    }
  }

  async function checkSnap() {
    const watched = new Set(); for (const c of Object.values(state.chats)) for (const v of c.votes) watched.add(v);
    const minVer = snap.config.minValidatorVersion || null;
    for (const vote of watched) {
      const s = state.seen[vote] || (state.seen[vote] = {});
      const dg = snap.deleg.get(vote);
      const name = nameOf(vote);
      const st = dg ? (dg.st || '?') : 'none';
      const fc = dg ? (dg.fc || []).slice() : [];
      // -- Delegation Program status / failing criteria
      if (s.st === undefined) { s.st = st; s.fc = fc; dirty = true; }
      else if (st !== s.st || !sameList(fc, s.fc)) {
        const was = s.st, wasFc = s.fc || [];
        s.st = st; s.fc = fc; dirty = true;
        let body;
        if (st === 'none') body = `is no longer listed in the Delegation Program (was ${esc(was)}).`;
        else if (was === 'none') body = `is now enrolled in the Delegation Program: <b>${esc(st)}</b>${fc.length ? ' — failing: ' + fc.map((k) => esc(criterionText(dg, k))).join(', ') : ''}.`;
        else if (st !== was) body = `Delegation Program: <b>${esc(was)}</b> → <b>${esc(st)}</b>${fc.length ? '\nFailing: ' + fc.map((k) => esc(criterionText(dg, k))).join(', ') : (wasFc.length ? '\nAll criteria met again.' : '')}`;
        else {
          const added = fc.filter((k) => !wasFc.includes(k)), gone = wasFc.filter((k) => !fc.includes(k));
          body = `Delegation Program (${esc(st)}): ` +
            [added.length ? `now failing ${added.map((k) => esc(criterionText(dg, k))).join(', ')}` : '', gone.length ? `no longer failing ${gone.map((k) => esc(CRITERIA[k] || k)).join(', ')}` : ''].filter(Boolean).join('; ') +
            (fc.length ? `\nStill failing: ${fc.map((k) => esc(criterionText(dg, k))).join(', ')}` : '\nAll criteria met.');
        }
        const good = st === 'Approved' && !fc.length;
        await alertAll(vote, `${good ? '🏛✅' : '🏛⚠️'} <b>${esc(name)}</b> ${body}\n${link(vote)}`);
      }
      // -- version below the Foundation minimum
      const c = dg && minVer ? cmpVer(dg.ver, minVer) : null;
      const behind = c === null ? null : c === -1;
      if (s.behind === undefined) { s.behind = behind; s.minVer = minVer; dirty = true; }
      else if (behind !== s.behind || (behind && minVer !== s.minVer)) {
        const wasBehind = s.behind, minChanged = minVer !== s.minVer;
        s.behind = behind; s.minVer = minVer; dirty = true;
        if (behind) {
          await alertAll(vote, `⬆️ <b>${esc(name)}</b> runs <b>v${esc(dg.ver)}</b> — ${minChanged ? `the Foundation minimum moved to <b>${esc(minVer)}</b>` : `below the Foundation minimum <b>${esc(minVer)}</b>`}. Upgrade to keep Delegation Program eligibility.\n${link(vote)}`);
        } else if (behind === false && wasBehind === true) {
          await alertAll(vote, `✅ <b>${esc(name)}</b> is on <b>v${esc(dg.ver)}</b> — at or above the Foundation minimum ${esc(minVer)}.\n${link(vote)}`);
        }
      }
    }
  }

  async function tick(force) {
    const t = now();
    const doSnap = force || !snap || t - (state.meta.lastSnap || 0) >= o.snapMs;
    if (doSnap && (await refreshSnap(true))) { state.meta.lastSnap = t; await checkSnap(); }
    const doLive = force || t - (state.meta.lastCheck || 0) >= o.checkMs;
    if (doLive && (await refreshLive(true))) { state.meta.lastCheck = t; await checkLive(); }
    await persistIfNeeded(false);
  }

  async function run({ minutes = 345, once = false } = {}) {
    loadState();
    await setCommands();
    if (once) { await tick(true); await persistIfNeeded(true); return; }
    const deadline = now() + minutes * 60000;
    log('info', `loop for ${minutes} min; checks every ${o.checkMs / 60000} min`);
    await tick(true);
    while (now() < deadline) {
      await pollUpdates();
      await tick(false);
    }
    await persistIfNeeded(true);
    log('info', `loop done: ${stats.checks} checks, ${stats.alerts} alerts, ${stats.rpcErrors} RPC errors`);
  }

  return {
    run, tick, pollUpdates, handleMessage, loadState, writeState, persistIfNeeded,
    refreshLive, refreshSnap, resolveTarget,
    get state() { return state; }, get stats() { return stats; }, get live() { return live; }, get snap() { return snap; },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const key = process.env.ALERTS_STATE_KEY;
  if (!token || !key) {
    console.log('[alerts] TELEGRAM_BOT_TOKEN and/or ALERTS_STATE_KEY not set — nothing to do (set both as repo secrets to enable the bot).');
    process.exit(0);
  }
  const bot = createBot({
    token, key,
    adminChatId: process.env.TELEGRAM_CHAT_ID || null,
    rpcUrl: process.env.X1_RPC_URL || DEFAULTS.rpcUrl,
    siteUrl: process.env.SITE_URL || DEFAULTS.siteUrl,
    stateFile: process.env.ALERTS_STATE_FILE || DEFAULTS.stateFile,
    commit: argv.includes('--commit'),
    branch: process.env.GITHUB_REF_NAME || DEFAULTS.branch,
    logLevel: process.env.ALERTS_LOG_LEVEL || 'info',
  });
  bot.run({ minutes: Number(arg('--minutes', 345)), once: argv.includes('--once') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[alerts] fatal:', e && e.stack || e); process.exit(1); });
}

module.exports = { createBot, encryptState, decryptState, cmpVer, esc, DEFAULTS, CRITERIA };
