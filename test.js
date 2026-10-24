// cache-guard 測試：圖片計數、保溫喚醒、各種不喚醒的情況
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-guard-test-'));
process.env.CACHE_GUARD_STATE_DIR = path.join(tmp, 'state');
const L = require('./lib');
const H = require('./hook');
const HOOK = path.join(__dirname, 'hook.js');
const FAST = { baselineSec: 0.5, pollSec: 0.2 };
const BG = { id: 'b1', type: 'shell', status: 'running', description: 'npm run build' };

function transcript(name, { ageSec, ctx = 100000, tier = '1h' }) {
  const file = path.join(tmp, `${name}.jsonl`);
  const t = Date.now() - ageSec * 1000;
  const cc = tier === '1h' ? { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 };
  const lines = [
    { type: 'api-request', querySource: 'repl_main_thread', timestamp: new Date(t).toISOString() },
    { type: 'assistant', timestamp: new Date(t + 4000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: ctx - 502, cache_creation_input_tokens: 500, cache_creation: cc } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function run(input, cfg = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CACHE_GUARD_CONFIG_JSON: JSON.stringify({ ...FAST, ...cfg }) } });
    let err = '';
    let out = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, err, out }));
    // 預設有一個背景工作在跑（在等），測「工作已完成」時再把它清掉
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', background_tasks: [BG], ...input }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await test('數圖片：Read 圖檔、MCP 內容陣列、純文字', () => {
    assert.strictEqual(H.countImages({ type: 'image', file: { base64: 'x' } }), 1);
    assert.strictEqual(H.countImages([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'image' }]), 2);
    assert.strictEqual(H.countImages({ content: [{ type: 'image' }] }), 1);
    assert.strictEqual(H.countImages('PDF file read'), 0);
    assert.strictEqual(H.countImages({ filePath: 'a.txt', type: 'text' }), 0);
  });

  await test('圖片到門檻只提醒一次，子代理不算', () => {
    const cfg = { ...L.DEFAULT_CONFIG, imageWarnAt: [3, 5] };
    const ev = (n) => ({ session_id: 'img', tool_response: Array.from({ length: n }, () => ({ type: 'image' })) });
    assert.strictEqual(H.onPostToolUse(ev(2), cfg), null);
    assert.match(H.onPostToolUse(ev(1), cfg).hookSpecificOutput.additionalContext, /3 張圖/);
    assert.strictEqual(H.onPostToolUse(ev(1), cfg), null);
    assert.ok(H.onPostToolUse(ev(3), cfg), '跨過 5 要再提醒');
    assert.strictEqual(H.onPostToolUse({ ...ev(9), agent_id: 'a1' }, cfg), null);
  });

  await test('快取快過期時喚醒（exit 2），保溫次數接著算', async () => {
    const tp = transcript('wake', { ageSec: 3298 });
    const r = await run({ session_id: 'wake', transcript_path: tp });
    assert.strictEqual(r.code, 2, r.err);
    assert.strictEqual(r.err, H.WAKE_MSG);
    assert.strictEqual(L.readJson(L.warmFile('wake')).pings, 1);
    // 保溫那一輪的 Stop：回一個字、stop_hook_active，次數要保留；上限 1 次所以不再喚醒
    const r2 = await run({ session_id: 'wake', transcript_path: tp, stop_hook_active: true, last_assistant_message: '.' }, { maxPings1h: 1 });
    assert.strictEqual(r2.code, 0);
    assert.strictEqual(L.readJson(L.warmFile('wake')).pings, 1);
  });

  await test('使用者回來過（不是保溫輪）就重新計數', async () => {
    const tp = transcript('back', { ageSec: 3298 });
    L.writeJson(L.warmFile('back'), { pings: 5, wokeAt: Date.now() - 3600e3 });
    const r = await run({ session_id: 'back', transcript_path: tp, last_assistant_message: '這是一段正常的長回覆，代表使用者真的回來工作了。' }, { maxPings1h: 1 });
    assert.strictEqual(r.code, 2, r.err);
  });

  await test('等待期間逐字稿有新紀錄就不喚醒', async () => {
    const tp = transcript('busy', { ageSec: 3297 });
    const p = run({ session_id: 'busy', transcript_path: tp });
    await sleep(1200);
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n');
    assert.strictEqual((await p).code, 0);
  });

  await test('閒置時 Claude Code 自己寫的 away_summary、cost-state 不算有人回來', async () => {
    const tp = transcript('away', { ageSec: 3297 });
    const p = run({ session_id: 'away', transcript_path: tp });
    await sleep(1200);
    fs.appendFileSync(tp, [{ type: 'system', subtype: 'away_summary', timestamp: new Date().toISOString() }, { type: 'cost-state' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.strictEqual((await p).code, 2);
  });

  await test('工作已完成（沒有背景工作、計時器，也沒問問題）不保溫', async () => {
    const r = await run({ session_id: 'done', transcript_path: transcript('done', { ageSec: 3298 }), background_tasks: [], session_crons: [], last_assistant_message: '已修好並推上 GitHub。' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(L.readJson(L.warmFile('done')).wait, null);
    // Claude Code 內部的背景工作不算在等
    const r2 = await run({ session_id: 'done', transcript_path: transcript('done', { ageSec: 3298 }), background_tasks: [{ ...BG, type: 'dream' }] });
    assert.strictEqual(r2.code, 0);
  });

  await test('等計時器、等使用者回答都保溫', async () => {
    const cron = await run({ session_id: 'cron', transcript_path: transcript('cron', { ageSec: 3298 }), background_tasks: [], session_crons: [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'x' }] });
    assert.strictEqual(cron.code, 2, cron.err);
    const tp = transcript('ask', { ageSec: 3298 });
    const ask = await run({ session_id: 'ask', transcript_path: tp, background_tasks: [], last_assistant_message: '兩個做法。\n\n要我照這個方式改 `cache-guard` 嗎？' });
    assert.strictEqual(ask.code, 2, ask.err);
    // 保溫那一輪只回「.」，要沿用「等使用者回答」繼續保溫
    const again = await run({ session_id: 'ask', transcript_path: tp, background_tasks: [], stop_hook_active: true, last_assistant_message: '.' });
    assert.strictEqual(again.code, 2, again.err);
    assert.strictEqual(L.readJson(L.warmFile('ask')).pings, 2);
  });

  await test('判斷問句：只看最後一行', () => {
    assert.ok(H.asksUser('要我改嗎？'));
    assert.ok(H.asksUser('Should I push?**'));
    assert.ok(!H.asksUser('為什麼會這樣？\n\n已經修好了。'));
    assert.ok(!H.asksUser(''));
  });

  await test('新的 Stop 接手後，舊的等待結束', async () => {
    const tp = transcript('owner', { ageSec: 3296 });
    const a = run({ session_id: 'owner', transcript_path: tp });
    await sleep(800);
    const b = run({ session_id: 'owner', transcript_path: tp });
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.code, 0);
    assert.strictEqual(rb.code, 2, rb.err);
  });

  await test('上下文太小、快取已過期都不喚醒', async () => {
    assert.strictEqual((await run({ session_id: 'small', transcript_path: transcript('small', { ageSec: 3298, ctx: 20000 }) })).code, 0);
    assert.strictEqual((await run({ session_id: 'old', transcript_path: transcript('old', { ageSec: 3700 }) })).code, 0);
  });

  await test('5 分鐘快取用 5m 的喚醒時間', async () => {
    const tp = transcript('five', { ageSec: 238, tier: '5m' });
    const r = await run({ session_id: 'five', transcript_path: tp });
    assert.strictEqual(r.code, 2, r.err);
    assert.strictEqual(L.readJson(L.warmFile('five')).tier, '5m');
  });

  await test('try：上下文再小也照短時間喚醒一次，之後作廢', async () => {
    L.writeJson(L.TRY_FILE, { sec: 1, expiresAt: Date.now() + 60e3 });
    const tp = transcript('try', { ageSec: 10, ctx: 1000 });
    const r = await run({ session_id: 'try', transcript_path: tp });
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /喚醒測試/);
    assert.ok(!fs.existsSync(L.TRY_FILE));
  });

  await test('SessionStart compact 把圖片數歸零', async () => {
    L.writeJson(L.imageFile('cmp'), { count: 40 });
    const child = spawn(process.execPath, [HOOK], { env: process.env });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'cmp' }));
    await new Promise((r) => child.on('exit', r));
    assert.strictEqual(L.readJson(L.imageFile('cmp')).count, 0);
  });

  console.log(results.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
})();
