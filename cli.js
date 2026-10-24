// cache-guard 指令：status、log、report、try
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./lib');

const [cmd, ...rest] = process.argv.slice(2);

function status() {
  const cfg = L.loadConfig();
  console.log(`啟用：${cfg.enabled ? '是' : '否'}｜保溫：${cfg.keepWarm ? '是' : '否'}（上下文 ≥ ${L.kTok(cfg.minContextTokens)}；1h 快取 ${cfg.wakeAfterSec1h} 秒後喚醒、最多 ${cfg.maxPings1h} 次；5m 快取 ${cfg.wakeAfterSec5m} 秒、最多 ${cfg.maxPings5m} 次）｜圖片提醒門檻：${cfg.imageWarnAt.join('、')}`);
  let files = [];
  try {
    files = fs.readdirSync(L.SESSIONS).filter((f) => f.endsWith('.warm.json'));
  } catch {}
  const rows = files.map((f) => ({ sid: f.slice(0, 8), ...L.readJson(path.join(L.SESSIONS, f), {}) })).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  for (const r of rows) {
    const img = L.readJson(L.imageFile(files.find((f) => f.startsWith(r.sid)).replace('.warm.json', '')), {}).count || 0;
    console.log(`${r.sid}｜${new Date(r.updatedAt).toLocaleString()}｜${r.tier}｜上下文 ${L.kTok(r.ctx || 0)}｜${r.wait || '工作已完成，不保溫'}｜本段已保溫 ${r.pings || 0} 次｜圖片 ${img} 張`);
  }
}

function showLog() {
  const n = Number(rest[0] || 30);
  try {
    console.log(fs.readFileSync(L.LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n'));
  } catch {
    console.log('還沒有紀錄');
  }
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// 由請求紀錄判斷這次失效的原因；api-request 紀錄的 keep 是跟上一次請求相同的訊息數、tail 是之後換掉的訊息雜湊
function causeOf(reqs, blobs, i) {
  const r = reqs[i];
  const p = reqs[i - 1];
  if (!r || !p) return '原因不明（舊版沒有請求紀錄）';
  if (r.keep < p.len - 1) {
    const first = JSON.stringify(blobs[r.tail[0]] || '');
    if (/media removed/.test(first)) return '圖片超量被移除';
    if (/usage limit has reset|usage is available again/.test(first)) return '限額重置後續跑';
    return '前面的訊息被改寫';
  }
  if (r.shapeHash !== p.shapeHash) return '工具清單或系統提示改變';
  return '原因不明（請求前綴沒變，伺服器端未命中）';
}

function analyze(file, since) {
  const recs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {}
  }
  const blobs = {};
  for (const r of recs) if (r.type === 'api-request-blob') blobs[r.hash] = r.message;
  // 重建主對話每次請求的訊息長度，給 causeOf 比較
  const reqs = [];
  let hist = [];
  for (const r of recs) {
    if (r.type !== 'api-request' || r.querySource !== 'repl_main_thread') continue;
    hist = hist.slice(0, r.keep).concat(r.tail || []);
    reqs.push({ t: Date.parse(r.timestamp), keep: r.keep, tail: r.tail || [], shapeHash: r.shapeHash, len: hist.length });
  }
  const out = { calls: 0, read: 0, w5: 0, w1h: 0, input: 0, events: [] };
  const seen = new Set();
  let prev = null;
  let compact = false;
  for (const r of recs) {
    if (r.subtype === 'compact_boundary' || r.isCompactSummary) compact = true;
    if (!L.isRealAssistant(r)) continue;
    const id = r.requestId || r.message.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = r.message.usage;
    const cc = u.cache_creation || {};
    const q = { t: Date.parse(r.timestamp), model: r.message.model, read: u.cache_read_input_tokens || 0, w1h: cc.ephemeral_1h_input_tokens || 0, input: u.input_tokens || 0 };
    q.w5 = cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens || 0) - q.w1h;
    if (q.t >= since) {
      out.calls++;
      out.read += q.read;
      out.w5 += q.w5;
      out.w1h += q.w1h;
      out.input += q.input;
      const write = q.w5 + q.w1h;
      const prevCtx = prev ? prev.read + prev.w5 + prev.w1h + prev.input : 0;
      if (prev && write > 15000 && q.read < prevCtx * 0.6) {
        const gap = (q.t - prev.t) / 1000;
        let cause;
        if (compact) cause = '壓縮對話（compact）';
        else if (q.model !== prev.model) cause = '換模型';
        else if (gap > 3600) cause = '閒置超過 1 小時';
        else if (gap > 300 && !q.w1h) cause = '5 分鐘快取過期';
        else {
          let i = reqs.length - 1;
          while (i >= 0 && reqs[i].t > q.t) i--;
          cause = reqs.length ? causeOf(reqs, blobs, i) : '原因不明（舊版沒有請求紀錄）';
        }
        const lost = Math.min(write, prevCtx);
        out.events.push({ t: q.t, cause, write, gap, waste: lost * ((q.w1h ? 2 : 1.25) - 0.1), file });
      }
    }
    compact = false;
    prev = q;
  }
  return out;
}

// 統計近幾天快取整段重寫的次數與原因，以及保溫花了多少
function report() {
  const days = Number(rest[0] || 30);
  const since = Date.now() - days * 86400e3;
  const root = path.join(os.homedir(), '.claude', 'projects');
  const tot = { calls: 0, read: 0, w5: 0, w1h: 0, input: 0 };
  const events = [];
  for (const f of walk(root)) {
    if (fs.statSync(f).mtimeMs < since) continue;
    const a = analyze(f, since);
    for (const k of Object.keys(tot)) tot[k] += a[k];
    events.push(...a.events);
  }
  const base = tot.input + tot.read * 0.1 + tot.w5 * 1.25 + tot.w1h * 2;
  console.log(`近 ${days} 天：請求 ${tot.calls}｜快取讀 ${L.kTok(tot.read)}｜5m 寫 ${L.kTok(tot.w5)}｜1h 寫 ${L.kTok(tot.w1h)}｜輸入側加權 ${L.kTok(base)}（輸入 1、讀 0.1、5m 寫 1.25、1h 寫 2）`);
  const by = {};
  for (const e of events) {
    const b = (by[e.cause] ??= { n: 0, write: 0, waste: 0 });
    b.n++;
    b.write += e.write;
    b.waste += e.waste;
  }
  console.log('\n原因｜次數｜重寫量｜比讀快取多付（加權）｜占輸入側');
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].waste - a[1].waste)) console.log(`${k}｜${v.n}｜${L.kTok(v.write)}｜${L.kTok(v.waste)}｜${((v.waste / base) * 100).toFixed(1)}%`);
  console.log('\n最大 10 筆：');
  for (const e of events.sort((a, b) => b.waste - a.waste).slice(0, 10)) console.log(`${new Date(e.t).toLocaleString()}｜${e.cause}｜重寫 ${L.kTok(e.write)}｜${path.relative(root, e.file).slice(0, 60)}`);
  // 保溫成本：每次約讀一次上下文（0.1 倍）
  let pings = 0;
  let cost = 0;
  try {
    for (const line of fs.readFileSync(L.LOG_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\S+) .*保溫第 \d+ 次.*上下文 (\d+)k/);
      if (m && Date.parse(m[1]) >= since) {
        pings++;
        cost += Number(m[2]) * 100;
      }
    }
  } catch {}
  console.log(`\n保溫：${pings} 次，約 ${L.kTok(cost)} 加權（占輸入側 ${base ? ((cost / base) * 100).toFixed(1) : 0}%）`);
}

// 排一次短時間喚醒：下一次 Stop 起算幾秒後喚醒，10 分鐘內沒有 Stop 就作廢
function tryWake() {
  const sec = Number(rest[0] || 60);
  L.writeJson(L.TRY_FILE, { sec, expiresAt: Date.now() + 10 * 60e3 });
  console.log(`已排喚醒測試：這一輪結束後約 ${sec + L.loadConfig().baselineSec} 秒，session 會被喚醒並回報「cache-guard 喚醒測試成功」；沒有被喚醒代表這個版本的 asyncRewake 無效。`);
}

switch (cmd) {
  case 'status':
    status();
    break;
  case 'try':
    tryWake();
    break;
  case 'log':
    showLog();
    break;
  case 'report':
    report();
    break;
  default:
    console.log('用法：node cli.js status｜log [行數]｜report [天數]｜try [秒數]');
}
