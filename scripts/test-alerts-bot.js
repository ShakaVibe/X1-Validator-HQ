#!/usr/bin/env node
'use strict';
// Mock tests for scripts/alerts-bot.js — no network, no Telegram, no git.
//   node scripts/test-alerts-bot.js
// Mocks: Telegram API (getUpdates queue + sendMessage capture), the X1 RPC
// (getEpochInfo / getVoteAccounts / getBlockProduction from a mutable `net`),
// the site's data/delegation.json + data/terminal.json, a manual clock and a
// persist() spy instead of git.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBot, encryptState, decryptState, cmpVer, esc } = require('./alerts-bot.js');

const KEY = 'ab'.repeat(32);
const TOKEN = '123:TESTTOKEN';
const V1 = 'Vote11111111111111111111111111111111111111';   // 42 chars, base58
const N1 = 'Node11111111111111111111111111111111111111';
const V2 = 'Vote22222222222222222222222222222222222222';
const N2 = 'Node22222222222222222222222222222222222222';
const V3 = 'Vote33333333333333333333333333333333333333';
const N3 = 'Node33333333333333333333333333333333333333';
const HOSTILE = 'Evil "<b>&\'name';

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------
let clock = Date.UTC(2026, 8, 28, 14, 0, 0);
const now = () => clock;
const advance = (ms) => { clock += ms; };
const MIN = 60000;

const net = {
  epoch: 392, slot: 82_200_000, firstSlot: 82_080_000,
  votes: {
    [V1]: { node: N1, commission: 10, delinquent: false, lastVote: 82_199_990, stake: '1000' },
    [V2]: { node: N2, commission: 5, delinquent: false, lastVote: 82_199_980, stake: '2000' },
    [V3]: { node: N3, commission: 10, delinquent: true, lastVote: 82_100_000, stake: '3000' },
  },
  prod: { [N1]: [120, 120], [N2]: [40, 40], [N3]: [0, 0] },
  rpcDown: false,
};
const site = {
  delegation: {
    generatedAt: '2026-09-28T13:03:14Z',
    config: { minSelfStake: '5000000000000', maxCommissionPercent: 10, minValidatorVersion: '4.0.3' },
    cluster: { skipRatePct: 0.09 },
    validators: {
      [V1]: { id: N1, name: 'Shaka_Vibes_1', st: 'Approved', fc: [], ss: '21498000000000', ds: '1289320000000000', cm: 10, ver: '4.0.3' },
      [V2]: { id: N2, name: HOSTILE, st: 'Approved', fc: ['minSelfStake'], ss: '2172451779', ds: '0', cm: 5, ver: '4.0.3' },
      // V3 not enrolled
    },
  },
  terminal: {
    validatorFields: ['votePubkey', 'nodePubkey', 'name', 'version'],
    validators: [[V1, N1, 'Shaka_Vibes_1', '4.0.3'], [V2, N2, HOSTILE, '4.0.3'], [V3, N3, 'Shaka_Vibes_3', '3.1.14']],
  },
  down: false,
};

const tg = { queue: [], sent: [], nextId: 1000, blocked: new Set(), commandsSet: 0 };
function incoming(chatId, text, type = 'private') {
  tg.queue.push({ update_id: tg.nextId++, message: { chat: { id: chatId, type }, text } });
}
function sentTo(chatId) { return tg.sent.filter((s) => String(s.chat_id) === String(chatId)).map((s) => s.text); }
function lastSent(chatId) { const a = sentTo(chatId); return a[a.length - 1]; }
function clearSent() { tg.sent.length = 0; }

const json = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
async function fetchMock(url, init = {}) {
  const u = String(url);
  if (u.startsWith(`https://api.telegram.org/bot${TOKEN}/`)) {
    const method = u.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    if (method === 'getUpdates') {
      const from = body.offset || 0;
      const batch = tg.queue.filter((x) => x.update_id >= from);
      return json({ ok: true, result: batch });
    }
    if (method === 'sendMessage') {
      if (tg.blocked.has(String(body.chat_id))) return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      tg.sent.push(body);
      return json({ ok: true, result: { message_id: tg.sent.length } });
    }
    if (method === 'setMyCommands') { tg.commandsSet++; return json({ ok: true, result: true }); }
    throw new Error('unexpected telegram method ' + method);
  }
  if (u === 'https://rpc.test') {
    if (net.rpcDown) return json({ error: 'nope' }, 503);
    const { method } = JSON.parse(init.body);
    if (method === 'getEpochInfo') return json({ result: { epoch: net.epoch, absoluteSlot: net.slot, slotIndex: net.slot - net.firstSlot } });
    if (method === 'getVoteAccounts') {
      const row = (v, x) => ({ votePubkey: v, nodePubkey: x.node, commission: x.commission, lastVote: x.lastVote, activatedStake: x.stake });
      const current = [], delinquent = [];
      for (const [v, x] of Object.entries(net.votes)) (x.delinquent ? delinquent : current).push(row(v, x));
      return json({ result: { current, delinquent } });
    }
    if (method === 'getBlockProduction') {
      const { range } = JSON.parse(init.body).params[0];
      assert.ok(range && range.firstSlot === net.firstSlot && range.lastSlot === net.slot - 64, 'range must cover the settled part of the epoch: ' + JSON.stringify(range));
      net.bpCalls = (net.bpCalls || 0) + 1;
      return json({ result: { value: { byIdentity: net.prod, range } } });
    }
    throw new Error('unexpected rpc ' + method);
  }
  if (u.startsWith('https://site.test/data/')) {
    if (site.down) return json({}, 503);
    if (u.includes('delegation.json')) return json(site.delegation);
    if (u.includes('terminal.json')) return json(site.terminal);
  }
  throw new Error('unexpected url ' + u);
}

// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
const stateFile = path.join(tmp, 'state.enc');
const persisted = [];
const logs = [];
function makeBot(extra = {}) {
  return createBot({
    token: TOKEN, key: KEY, adminChatId: '999', rpcUrl: 'https://rpc.test', siteUrl: 'https://site.test',
    stateFile, fetch: fetchMock, now, log: (l, m) => logs.push(`${l}: ${m}`),
    persist: async (f) => persisted.push({ at: now(), size: fs.statSync(f).size }),
    pollTimeoutS: 0, ...extra,
  });
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name); console.log(e.stack || e); process.exitCode = 1; }
}

(async () => {
  console.log('alerts-bot tests');

  await test('state file encrypts and round-trips; wrong key fails', () => {
    const s = { v: 1, chats: { 42: { votes: [V1] } } };
    const text = encryptState(s, KEY);
    assert.ok(text.startsWith('X1HQ-ALERTS-v1\n'));
    assert.ok(!text.includes('42') && !text.includes(V1), 'ciphertext must not leak the payload');
    assert.deepStrictEqual(decryptState(text, KEY), s);
    assert.throws(() => decryptState(text, 'cd'.repeat(32)));
  });

  await test('semver compare + html escape', () => {
    assert.strictEqual(cmpVer('3.1.14', '4.0.3'), -1);
    assert.strictEqual(cmpVer('4.0.3', '4.0.3'), 0);
    assert.strictEqual(cmpVer('4.1.0', '4.0.3'), 1);
    assert.strictEqual(cmpVer('unknown', '4.0.3'), null);
    assert.strictEqual(esc(HOSTILE), 'Evil &quot;&lt;b&gt;&amp;\'name');
  });

  const bot = makeBot();
  await test('first run seeds silently: no alerts, commands registered, no state file', async () => {
    bot.loadState();
    await bot.tick(true);
    assert.strictEqual(tg.sent.length, 0);
    assert.strictEqual(bot.live.votes.size, 3);
    assert.strictEqual(bot.snap.names.get(V2), HOSTILE);
    assert.ok(!fs.existsSync(stateFile), 'nothing watched → nothing to persist');
  });

  await test('/help, /watch by name, by vote key, by identity, several at once, hostile name escaped', async () => {
    incoming(42, '/start');
    incoming(42, '/watch Shaka_Vibes_1');
    incoming(42, `/watch ${V2} ${N3}`);   // vote key + node identity
    await bot.pollUpdates();
    const msgs = sentTo(42);
    assert.strictEqual(msgs.length, 3);
    assert.ok(msgs[0].includes('/watch'), 'help text');
    assert.ok(msgs[1].includes('✓ watching <b>Shaka_Vibes_1</b> 🟢 voting'), msgs[1]);
    assert.ok(msgs[2].includes(`✓ watching <b>${esc(HOSTILE)}</b>`), msgs[2]);
    assert.ok(!msgs[2].includes('<b>Evil "<b>'), 'raw name must not reach Telegram');
    assert.ok(msgs[2].includes('✓ watching <b>Shaka_Vibes_3</b> 🔴 delinquent'), msgs[2]);
    assert.deepStrictEqual(bot.state.chats['42'].votes, [V1, V2, V3]);
    assert.ok(fs.existsSync(stateFile) && persisted.length >= 1, 'subscription change persisted immediately');
    const s = decryptState(fs.readFileSync(stateFile, 'utf8'), KEY);
    assert.strictEqual(s.chats['42'].votes.length, 3);
    assert.strictEqual(s.seen[V3].d, true, 'V3 seeded as delinquent');
  });

  await test('/watch ambiguity, unknown, duplicates; group command with @bot suffix; /list', async () => {
    clearSent();
    incoming(42, '/watch Shaka');            // ambiguous (2 matches)
    incoming(42, '/watch nobody_here');
    incoming(42, '/watch Shaka_Vibes_1');    // duplicate
    incoming(-77, '/watch@x1valhq_bot "Shaka_Vibes_1"', 'supergroup');
    incoming(42, '/list');
    await bot.pollUpdates();
    const m = sentTo(42);
    assert.ok(m[0].includes('matches several'), m[0]);
    assert.ok(m[1].includes('no validator named'), m[1]);
    assert.ok(m[2].includes('already watching'), m[2]);
    assert.ok(m[3].startsWith('Watching 3 validator(s)'), m[3]);
    assert.ok(m[3].includes(`<code>${V1}</code>`));
    assert.deepStrictEqual(bot.state.chats['-77'].votes, [V1]);
  });

  await test('delinquent → one alert to every watcher; stays delinquent → no repeat', async () => {
    clearSent();
    net.votes[V1].delinquent = true; net.votes[V1].lastVote = net.slot - 1000;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(sentTo(42).length, 1); assert.strictEqual(sentTo(-77).length, 1);
    const t = lastSent(42);
    assert.ok(t.includes('🔴 <b>Shaka_Vibes_1</b> is <b>delinquent</b>'), t);
    assert.ok(t.includes('1,000 slots behind (~6 min)'), t);
    assert.ok(t.includes(`href="https://site.test/#/lookup/${V1}"`), t);
    advance(5 * MIN); await bot.tick(false);
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 2, 'no repeat while still delinquent');
  });

  await test('recovery needs 2 consecutive clean checks; a flap in between resets', async () => {
    clearSent();
    net.votes[V1].delinquent = false;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0, 'one clean check is not enough');
    net.votes[V1].delinquent = true;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0, 'flap back: no new delinquent alert (state never left delinquent)');
    net.votes[V1].delinquent = false;
    advance(5 * MIN); await bot.tick(false);
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(sentTo(42).length, 1);
    assert.ok(lastSent(42).includes('🟢 <b>Shaka_Vibes_1</b> is voting again (was delinquent for ~30 min)'), lastSent(42));
    // and it can go delinquent again afterwards
    clearSent();
    net.votes[V1].delinquent = true;
    advance(5 * MIN); await bot.tick(false);
    assert.ok(lastSent(42).includes('is <b>delinquent</b>'));
    net.votes[V1].delinquent = false;
    advance(5 * MIN); await bot.tick(false); advance(5 * MIN); await bot.tick(false);
    clearSent();
  });

  await test('leader-slot skips: first skip alerts, more within 30 min coalesce into one, epoch rollover resets', async () => {
    net.prod[N1] = [130, 129];                     // 1 skip
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(sentTo(42).length, 1);
    assert.ok(lastSent(42).includes('skipped <b>1 leader slot</b>'), lastSent(42));
    assert.ok(lastSent(42).includes('1 of 130 leader slots skipped (0.77%) · network avg 0.09%'), lastSent(42));
    clearSent();
    net.prod[N1] = [140, 137];                     // +2
    advance(5 * MIN); await bot.tick(false);
    net.prod[N1] = [150, 146];                     // +1
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0, 'within the window: held');
    advance(20 * MIN); await bot.tick(false);      // window over (30 min since the alert)
    assert.strictEqual(sentTo(42).length, 1);
    assert.ok(lastSent(42).includes('skipped <b>3 leader slots</b>'), lastSent(42));
    assert.ok(lastSent(42).includes('4 of 150'), lastSent(42));
    clearSent();
    // new epoch: counters restart, old skips are not re-reported; new skips are
    net.epoch = 393; net.firstSlot = 82_296_000; net.slot = 82_300_000; net.prod[N1] = [10, 10];
    advance(35 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0);
    net.prod[N1] = [12, 11];
    advance(5 * MIN); await bot.tick(false);
    assert.ok(lastSent(42).includes('Epoch 393 so far: 1 of 12'), lastSent(42));
    clearSent();
    // right after an epoch boundary (< 64 slots in) no block-production call is made and nothing alerts
    net.epoch = 394; net.firstSlot = 82_512_000; net.slot = 82_512_010; net.prod[N1] = [3, 0];
    const calls = net.bpCalls;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(net.bpCalls, calls, 'no getBlockProduction inside the settle window');
    assert.strictEqual(tg.sent.length, 0);
    net.slot = 82_513_000; net.prod[N1] = [3, 3];
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0);
  });

  await test('Delegation Program: new failing criterion, status flip, all criteria met again', async () => {
    site.delegation.validators[V1].fc = ['minVoteCredits'];
    advance(30 * MIN); await bot.tick(false);      // snapshot cadence
    assert.strictEqual(sentTo(42).length, 1);
    let t = lastSent(42);
    assert.ok(t.includes('🏛⚠️ <b>Shaka_Vibes_1</b> Delegation Program (Approved): now failing vote credits below the threshold'), t);
    clearSent();
    site.delegation.validators[V1].st = 'Rejected';
    advance(30 * MIN); await bot.tick(false);
    t = lastSent(42);
    assert.ok(t.includes('Delegation Program: <b>Approved</b> → <b>Rejected</b>'), t);
    assert.ok(t.includes('Failing: vote credits below the threshold'), t);
    clearSent();
    site.delegation.validators[V1].st = 'Approved'; site.delegation.validators[V1].fc = [];
    advance(30 * MIN); await bot.tick(false);
    t = lastSent(42);
    assert.ok(t.includes('🏛✅ <b>Shaka_Vibes_1</b> Delegation Program: <b>Rejected</b> → <b>Approved</b>\nAll criteria met again.'), t);
    // V2's headroom text uses config numbers
    clearSent();
    incoming(42, '/status');
    await bot.pollUpdates();
    t = lastSent(42);
    assert.ok(t.includes('self-stake 2.17 XNT &lt; 5,000 XNT minimum'), t);
    assert.ok(t.includes(`<b>${esc(HOSTILE)}</b>: 🟢 voting`), t);
    assert.ok(t.includes('<b>Shaka_Vibes_3</b>: 🔴 delinquent'), t);
    assert.ok(t.includes('not enrolled in the Delegation Program'), t);
    clearSent();
  });

  await test('version: min moves above the validator → alert; upgrade → all-clear; unknown version → silent', async () => {
    site.delegation.config.minValidatorVersion = '4.1.0';
    advance(30 * MIN); await bot.tick(false);
    const m = sentTo(42);
    // V1 and V2 both run 4.0.3 → both behind now; each gets one alert (V3 is not enrolled → no version data)
    assert.strictEqual(m.length, 2, m.join('\n---\n'));
    assert.ok(m[0].includes('⬆️ <b>Shaka_Vibes_1</b> runs <b>v4.0.3</b> — the Foundation minimum moved to <b>4.1.0</b>'), m[0]);
    clearSent();
    site.delegation.validators[V1].ver = '4.1.0';
    advance(30 * MIN); await bot.tick(false);
    assert.strictEqual(sentTo(42).length, 1);
    assert.ok(lastSent(42).includes('✅ <b>Shaka_Vibes_1</b> is on <b>v4.1.0</b>'), lastSent(42));
    clearSent();
    site.delegation.validators[V2].ver = 'unknown';
    advance(30 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0, 'unknown version is not an alert');
    clearSent();
  });

  await test('validator vanishes from the vote list → one notice; reappears → silent', async () => {
    const saved = net.votes[V3]; delete net.votes[V3];
    advance(5 * MIN); await bot.tick(false);
    assert.ok(lastSent(42).includes('⚪ <b>Shaka_Vibes_3</b> is no longer in the network'), lastSent(42));
    clearSent();
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0);
    net.votes[V3] = saved;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(tg.sent.length, 0);
  });

  await test('blocked chat (403) is dropped from subscriptions; others still alerted', async () => {
    tg.blocked.add('-77');
    net.votes[V1].delinquent = true;
    advance(5 * MIN); await bot.tick(false);
    assert.strictEqual(sentTo(42).length, 1);
    assert.strictEqual(bot.state.chats['-77'], undefined);
    tg.blocked.delete('-77');
    net.votes[V1].delinquent = false;
    advance(5 * MIN); await bot.tick(false); advance(5 * MIN); await bot.tick(false);
    clearSent();
  });

  await test('/unwatch by name and all; state pruned; unknown command only answered in private', async () => {
    incoming(42, '/unwatch Shaka_Vibes_3');
    incoming(42, '/frobnicate');
    incoming(-77, '/frobnicate', 'supergroup');
    await bot.pollUpdates();
    assert.ok(sentTo(42)[0].includes('✓ stopped watching <b>Shaka_Vibes_3</b>'));
    assert.ok(sentTo(42)[1].includes('Unknown command'));
    assert.strictEqual(sentTo(-77).length, 0);
    assert.deepStrictEqual(bot.state.chats['42'].votes, [V1, V2]);
    const s = decryptState(fs.readFileSync(stateFile, 'utf8'), KEY);
    assert.ok(!s.seen[V3], 'unwatched validator pruned from seen');
    clearSent();
    incoming(42, '/unwatch all');
    await bot.pollUpdates();
    assert.ok(lastSent(42).includes('Stopped watching 2 validator(s)'));
    assert.strictEqual(bot.state.chats['42'], undefined);
  });

  await test('admin /stats answers only the admin chat', async () => {
    clearSent();
    incoming(42, '/stats'); incoming(999, '/stats');
    await bot.pollUpdates();
    assert.strictEqual(sentTo(42).length, 0);
    assert.ok(lastSent(999).includes('<b>Alerts bot</b>'), lastSent(999));
  });

  await test('RPC down: checks skipped, admin told once after 30 min, recovery logged; site down: snapshot kept', async () => {
    clearSent();
    incoming(42, '/watch Shaka_Vibes_1'); await bot.pollUpdates(); clearSent();
    net.rpcDown = true;
    for (let i = 0; i < 7; i++) { advance(5 * MIN); await bot.tick(false); }
    assert.strictEqual(sentTo(999).length, 1, 'exactly one RPC-down notice');
    assert.ok(lastSent(999).includes('the RPC has not answered for'), lastSent(999));
    net.votes[V1].delinquent = true;          // happened while RPC was down
    net.rpcDown = false;
    advance(5 * MIN); await bot.tick(false);
    assert.ok(lastSent(42).includes('is <b>delinquent</b>'), 'caught up after the RPC came back');
    assert.ok(logs.some((l) => l.includes('RPC back after')));
    net.votes[V1].delinquent = false; advance(5 * MIN); await bot.tick(false); advance(5 * MIN); await bot.tick(false);
    clearSent();
    site.down = true;
    const before = bot.snap;
    advance(30 * MIN); await bot.tick(false);
    assert.strictEqual(bot.snap, before, 'old snapshot kept when the site fails');
    assert.strictEqual(tg.sent.length, 0);
    site.down = false;
  });

  await test('status-only changes commit at most every 10 min; a fresh bot reloads the same state', async () => {
    const n = persisted.length;
    net.votes[V1].delinquent = true;
    advance(5 * MIN); await bot.tick(false);          // alert → dirty → commit (last one was long ago)
    const n1 = persisted.length;
    assert.ok(n1 > n, 'committed');
    net.votes[V1].delinquent = false;
    advance(5 * MIN); await bot.tick(false);          // clean=1 → dirty, but < 10 min since the commit
    assert.strictEqual(persisted.length, n1, 'debounced');
    advance(5 * MIN); await bot.tick(false);          // recovery alert, 10 min since → commit
    assert.strictEqual(persisted.length, n1 + 1);
    clearSent();
    const bot2 = makeBot();
    bot2.loadState();
    assert.deepStrictEqual(bot2.state.chats['42'].votes, [V1]);
    assert.strictEqual(bot2.state.offset, bot.state.offset);
    await bot2.tick(true);
    assert.strictEqual(tg.sent.length, 0, 'restart with the same world → no alerts');
  });

  await test('run --once: seeds, checks, persists, registers commands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-once-'));
    const b = makeBot({ stateFile: path.join(dir, 's.enc') });
    const before = tg.commandsSet;
    await b.run({ once: true });
    assert.strictEqual(tg.commandsSet, before + 1);
    assert.strictEqual(b.stats.checks, 1);
  });

  await test('constructor refuses a missing token or a bad key', () => {
    assert.throws(() => createBot({ key: KEY }), /TELEGRAM_BOT_TOKEN/);
    assert.throws(() => createBot({ token: TOKEN, key: 'short' }), /ALERTS_STATE_KEY/);
  });

  await test('logs never contain a chat id or a validator name', () => {
    const joined = logs.join('\n');
    assert.ok(!joined.includes('42') || !/\b42\b/.test(joined.replace(/#[0-9a-f]{4}/g, '')), joined);
    assert.ok(!joined.includes('-77'));
    assert.ok(!joined.includes('Shaka_Vibes'));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
