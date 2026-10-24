// cache-guard 的 hook 入口：Stop（背景保溫，asyncRewake）、PostToolUse（圖片計數）、SessionStart（壓縮後歸零）
'use strict';
const L = require('./lib');

const WAKE_MSG = 'cache-guard 自動保溫（不是使用者訊息）：只回覆「.」，不要呼叫工具，也不要接著做其他事。';

const TRY_MSG = 'cache-guard 喚醒測試（不是使用者訊息）：asyncRewake 喚醒成功。回報一行「cache-guard 喚醒測試成功」，不要呼叫工具。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop 後在背景等到快取快過期，期間沒有新動靜就用 exit 2 喚醒 session 讀一次快取
async function onStop(input, cfg) {
  if (!cfg.keepWarm || input.agent_id) return 0;
  const sid = input.session_id;
  const tp = input.transcript_path;
  const tag = `[${String(sid).slice(0, 8)}]`;
  const last = L.lastRequest(L.tailRecords(tp));
  if (!last) return 0;

  const prev = L.readJson(L.warmFile(sid), {});
  const tier = last.tier || prev.tier || '1h';
  // 剛被喚醒、回了一個字就停的那一輪也會觸發 Stop：保溫次數接著算，其他情況代表使用者回來過，重新計算
  const reply = String(input.last_assistant_message || '').trim();
  const isPing = Boolean(prev.wokeAt) && Date.now() - prev.wokeAt < 10 * 60e3 && (input.stop_hook_active || reply.length <= 20);
  const pings = isPing ? prev.pings || 0 : 0;
  const owner = `${process.pid}-${Date.now()}`;
  const st = { owner, tier, pings, wokeAt: isPing ? prev.wokeAt : 0, anchor: last.anchor, ctx: last.ctx, updatedAt: Date.now() };
  L.writeJson(L.warmFile(sid), st);

  const trial = L.readJson(L.TRY_FILE);
  const isTrial = Boolean(trial && trial.expiresAt > Date.now());
  if (!isTrial) {
    if (last.ctx < cfg.minContextTokens) return 0;
    const max = tier === '5m' ? cfg.maxPings5m : cfg.maxPings1h;
    const skip = pings >= max ? `已保溫 ${pings} 次，達上限` : L.handedOff(sid);
    if (skip) {
      L.log(`${tag} 不保溫：${skip}`);
      return 0;
    }
  }

  const ttlMs = tier === '5m' ? 5 * 60e3 : 60 * 60e3;
  const wakeAt = isTrial ? Date.now() + trial.sec * 1000 : last.anchor + (tier === '5m' ? cfg.wakeAfterSec5m : cfg.wakeAfterSec1h) * 1000;
  await sleep(Math.max(0, Math.min(cfg.baselineSec * 1000, wakeAt - Date.now())));
  const base = L.fileSize(tp);
  for (;;) {
    if (L.readJson(L.warmFile(sid), {}).owner !== owner) return 0;
    if (L.fileSize(tp) !== base) return 0;
    const left = wakeAt - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(left, cfg.pollSec * 1000));
  }
  // 電腦睡眠等原因醒得太晚，快取已經過期就不必再花一次
  if (Date.now() - last.anchor >= ttlMs) {
    L.log(`${tag} 醒來時快取已過期（距上次請求 ${Math.round((Date.now() - last.anchor) / 60e3)} 分），不保溫`);
    return 0;
  }
  const pct = L.usagePct();
  if (pct !== null && pct >= cfg.maxUsagePct) {
    L.log(`${tag} 不保溫：5 小時用量 ${pct}%`);
    return 0;
  }
  if (isTrial) {
    try {
      require('fs').unlinkSync(L.TRY_FILE);
    } catch {}
    L.log(`${tag} 喚醒測試（上下文 ${L.kTok(last.ctx)}）`);
    process.stderr.write(TRY_MSG);
    return 2;
  }
  L.writeJson(L.warmFile(sid), { ...st, pings: pings + 1, wokeAt: Date.now(), updatedAt: Date.now() });
  L.log(`${tag} 保溫第 ${pings + 1} 次（${tier} 快取，上下文 ${L.kTok(last.ctx)}）`);
  process.stderr.write(WAKE_MSG);
  return 2;
}

// 數 tool_response 裡的圖片：Read 圖檔是 {type:'image'}，MCP 截圖是內容陣列裡的 image 區塊
function countImages(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return 0;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countImages(x, depth + 1), 0);
  if (v.type === 'image') return 1;
  let n = 0;
  for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') n += countImages(v[k], depth + 1);
  return n;
}

function onPostToolUse(input, cfg) {
  if (input.agent_id) return null;
  const n = countImages(input.tool_response);
  if (!n) return null;
  const file = L.imageFile(input.session_id);
  const before = L.readJson(file, {}).count || 0;
  const count = before + n;
  L.writeJson(file, { count, updatedAt: Date.now() });
  if (!cfg.imageWarnAt.some((t) => before < t && count >= t)) return null;
  L.log(`[${String(input.session_id).slice(0, 8)}] 圖片累積 ${count} 張，提醒一次`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `cache-guard：這個對話已讀進 ${count} 張圖。累積到約 60 張後 Claude Code 會開始移除舊圖，每移除一次就整段快取重寫。還要看很多圖的話，改交給子代理看、先拼成總表，或請使用者先 /compact。`,
    },
  };
}

// 壓縮或清除後舊圖都不在上下文裡了，重新計數
function onSessionStart(input) {
  if (['compact', 'clear'].includes(input.source)) L.writeJson(L.imageFile(input.session_id), { count: 0, updatedAt: Date.now() });
}

async function main() {
  const input = L.readStdin();
  const cfg = L.loadConfig();
  if (!cfg.enabled || !input.session_id) return 0;
  if (cfg.debug) L.writeJson(`${L.STATE}/debug/${input.hook_event_name}-${Date.now()}.json`, { ...input, tool_response: input.tool_response ? '(略)' : undefined });
  switch (input.hook_event_name) {
    case 'Stop':
      return onStop(input, cfg);
    case 'PostToolUse': {
      const out = onPostToolUse(input, cfg);
      if (out) process.stdout.write(JSON.stringify(out));
      return 0;
    }
    case 'SessionStart':
      onSessionStart(input);
      return 0;
    default:
      return 0;
  }
}

if (require.main === module) {
  // 出錯一律安靜結束（exit 0），絕不因為錯誤喚醒 session
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      L.log(`錯誤：${e.stack || e}`);
      process.exit(0);
    });
}

module.exports = { countImages, onPostToolUse, WAKE_MSG };
