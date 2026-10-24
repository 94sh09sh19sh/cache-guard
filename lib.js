// cache-guard 共用函式：路徑、設定、狀態檔、記錄、逐字稿讀取
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// CACHE_GUARD_STATE_DIR 只給測試用，避免弄髒正式狀態
const STATE = process.env.CACHE_GUARD_STATE_DIR || path.join(ROOT, 'state');
const SESSIONS = path.join(STATE, 'sessions');
const LOG_FILE = path.join(STATE, 'guard.log');
// cli.js try 寫入：下一次 Stop 改用短時間喚醒一次，驗證這個版本的 asyncRewake 有效
const TRY_FILE = path.join(STATE, 'try.json');

const DEFAULT_CONFIG = {
  enabled: true,
  keepWarm: true,
  // 上下文小於這個值不保溫：重寫本來就便宜，保溫還要吃 5 小時額度
  minContextTokens: 50000,
  // 1 小時快取：最後一次請求後 55 分鐘喚醒；每段閒置最多保溫 8 次（Claude Code 連續接續上限也是 8）
  wakeAfterSec1h: 3300,
  maxPings1h: 8,
  // 超額時快取只有 5 分鐘：重寫 1.25 倍，保溫一次 0.1 倍，所以只撐半小時
  wakeAfterSec5m: 240,
  maxPings5m: 6,
  // 5 小時用量到這個百分比就不保溫，額度留給正事（讀 limit-relay 的用量檔）
  maxUsagePct: 90,
  // 對話累積的圖片張數到這些門檻時各提醒一次
  imageWarnAt: [30, 50],
  // 工作已做完的 session 不保溫，只保溫還在等背景工作或計時器的
  // Claude Code 自己的背景工作（background_tasks 的 type），不算在等
  ignoreTaskTypes: ['dream', 'auto-mode scan', 'memory import'],
  // Stop 後等多久才記下逐字稿位置當基準（Claude Code 收尾還會寫幾筆紀錄）、之後多久檢查一次
  baselineSec: 20,
  pollSec: 15,
  debug: false,
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免多個 hook 同時寫入時讀到半個檔案
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  // CACHE_GUARD_CONFIG_JSON 只給測試用，可以臨時覆寫設定
  let env = {};
  try {
    env = JSON.parse(process.env.CACHE_GUARD_CONFIG_JSON || '{}');
  } catch {}
  // config.json 是 repo 的預設值；config.local.json 是本機個人設定，部署不會覆蓋
  return { ...DEFAULT_CONFIG, ...readJson(path.join(ROOT, 'config.json'), {}), ...readJson(path.join(ROOT, 'config.local.json'), {}), ...env };
}

function log(msg) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// 保溫和圖片計數分開存，PostToolUse 與 Stop 同時寫也不會互相蓋掉
const warmFile = (sid) => path.join(SESSIONS, `${sid}.warm.json`);
const imageFile = (sid) => path.join(SESSIONS, `${sid}.images.json`);

// 讀逐字稿最後一段，由新到舊回傳解析後的紀錄；圖片的 base64 很占空間，所以讀多一點
function tailRecords(file, bytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        out.push(JSON.parse(lines[i]));
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
};

// 逐字稿從 offset 之後有沒有真的對話紀錄。Claude Code 閒置時也會自己寫 system 紀錄（離開約 3 分鐘後的 away_summary 等）
// 和沒有時間的狀態紀錄（cost-state、ai-title 等），這些不代表有人在用
function hasActivitySince(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return false;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8').split('\n').some((line) => {
      if (!line.trim()) return false;
      try {
        const r = JSON.parse(line);
        return Boolean(r.timestamp) && r.type !== 'system';
      } catch {
        // 還沒寫完的半行：等下一次檢查再看
        return false;
      }
    });
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isRealAssistant =(r) => r.type === 'assistant' && !r.isSidechain && r.message?.usage && r.message.model !== '<synthetic>';

function contextTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// 最後一次主對話請求：快取從送出請求那一刻起算，所以用 api-request 的時間；舊版沒有這筆紀錄就往前抓 5 分鐘
function lastRequest(records) {
  const a = records.find(isRealAssistant);
  if (!a) return null;
  const at = Date.parse(a.timestamp);
  const req = records.find((r) => r.type === 'api-request' && r.querySource === 'repl_main_thread' && Date.parse(r.timestamp) <= at && at - Date.parse(r.timestamp) < 30 * 60e3);
  const u = a.message.usage;
  const cc = u.cache_creation || {};
  const tier = cc.ephemeral_1h_input_tokens > 0 ? '1h' : cc.ephemeral_5m_input_tokens > 0 ? '5m' : null;
  return { anchor: req ? Date.parse(req.timestamp) : at - 5 * 60e3, ctx: contextTokens(u), tier };
}

// limit-relay 的用量檔：所有 session 都閒置時不會更新，所以不看新舊，改用同一個 5 小時視窗內的下限；沒裝就當不知道
function usagePct() {
  try {
    const f = require('../limit-relay/lib').usageFloor();
    return typeof f?.used === 'number' ? f.used : null;
  } catch {
    return null;
  }
}

// 其他工具已經改由新 session 接手時，舊 session 不用保溫
function handedOff(sid) {
  try {
    const I = require('../iter-chain/lib');
    const s = I.readJson(I.sessionFile(sid));
    const r = s && I.loadChain(s.chainId)?.rounds?.find((x) => x.k === s.k);
    if (r?.status === 'done') return 'iter-chain 已開下一輪';
  } catch {}
  try {
    const R = require('../limit-relay/lib');
    const job = R.loadSession(sid).hit?.jobId && R.loadJob(R.loadSession(sid).hit.jobId);
    if (job && ['waiting', 'launched', 'resumed'].includes(job.status)) return 'limit-relay 已安排接手';
  } catch {}
  return null;
}

const kTok = (n) => `${Math.round(n / 1000)}k`;

module.exports = {
  ROOT, STATE, SESSIONS, LOG_FILE, TRY_FILE, DEFAULT_CONFIG,
  readJson, writeJson, loadConfig, log, readStdin, warmFile, imageFile,
  tailRecords, fileSize, hasActivitySince, isRealAssistant, contextTokens, lastRequest, usagePct, handedOff, kTok,
};
