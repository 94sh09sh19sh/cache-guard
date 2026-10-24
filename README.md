# cache-guard

減少 Claude Code 主對話的快取整段重寫：閒置快過期時自動保溫，圖片累積太多時提醒改做法，並統計每次重寫的原因。

## 為什麼
- 快取 1 小時沒用就過期；之後第一個請求要把整段上下文用 2 倍價格重寫，讀快取只要 0.1 倍。40 萬 token 的對話，一次重寫等於讀 20 次。
- 實際統計發現：閒置過期不是唯一來源。圖片累積到約 60 張後，Claude Code 會把舊圖換成 `[media removed]`，等於改寫前面的訊息；之後每多一張圖，快取就整段重寫一次。
- `node cli.js report` 會逐筆找出重寫，從 Claude Code 的請求紀錄判斷原因，先看自己的數字再決定要不要開保溫。

## 功能
- 保溫（Stop hook，`asyncRewake`）：每輪結束後在背景等，到最後一次請求後 55 分鐘仍沒有新動靜，就用 exit 2 喚醒 session，請模型只回一個「.」。這一輪只讀快取，快取的有效期重新起算。
- 圖片提醒（PostToolUse）：Read 圖檔或 MCP 工具回傳圖片時計數，到 30、50 張各提醒模型一次：改交給子代理看、先拼成總表，或請你 `/compact`。不會擋下任何操作。
- 壓縮後歸零（SessionStart compact／clear）。
- 沒事時不輸出任何東西，不花 token。

## 保溫規則
- 只保溫上下文 ≥ 5 萬 token 的主對話；子代理不保溫。
- 只保溫還在等的 session，工作已做完的不保溫。「在等」指以下任一種：
  - 背景工作還在跑：背景指令、背景子代理、Monitor、workflow、teammate 等（Stop hook 輸入的 `background_tasks`；Claude Code 自己的 dream、auto-mode scan、memory import 不算）。
  - 有計時器會叫醒它：ScheduleWakeup、CronCreate、`/loop`（`session_crons`）。
  - 在等使用者回答：最後一則回覆的最後一行是問句（結尾是「？」或「?」）。
- 使用者回來（正常的一輪）就重新計算；每段閒置最多 8 次，約 8 小時。Claude Code 的 Stop hook 連續接續上限也是 8。
- 超額時快取只有 5 分鐘：改成 4 分鐘喚醒、最多 6 次（重寫 1.25 倍，保溫 6 次約 0.6 倍）。由最後一次回應的 `cache_creation` 自動判斷。
- 不保溫的情況：等待期間逐字稿有新的對話紀錄（正在做事、背景工作完成後接手；Claude Code 閒置時自己寫的 `away_summary` 等 system 紀錄不算）、同一 session 又有新的 Stop 接手、醒來時快取已過期（例如電腦睡眠）、5 小時用量 ≥ 90%（讀 limit-relay 的用量檔；所有 session 都閒置時用量檔不會更新，但同一個 5 小時視窗內用量只增不減，所以舊值當下限照用，視窗重置後才歸零）、iter-chain 已開下一輪、limit-relay 已安排新 session 接手。

## 划不划算
- 保溫一次花 0.1C（C 是上下文大小），重寫多花 1.9C；最多 8 次共 0.8C。只要回到這個 session 的機率超過約 4 成就划算。
- 確定不會再回來的 session 直接關掉，背景等待會跟著結束。
- 訂閱方案的保溫一樣吃 5 小時額度，所以用量高時自動停。

## 參考的開源專案（都是 MIT，星數都不到 1000，所以自己做）
- qyh9527/claude-code-cache-keepalive：Stop hook 用 `asyncRewake` 加 exit 2 喚醒、新 Stop 接手時舊的退出、出錯絕不喚醒。採用。
- demouo/claude-code-cache-keepalive：以最後一次活動重新起算的閒置計時、閒置上限。採用。它要模型先開 Monitor，這裡改成 hook 直接做，不用模型配合。
- cnighswonger/claude-code-coffee：保溫與重寫的划算點計算。用在預設上限。
- Pan1127/cc-cache-keepalive：用 `--fork-session` 從外部保溫、不改原對話。不採用：`-p` 的系統提示和工具清單與互動模式不同，前綴對不上就保不到溫。
- lllq-123/claude-code-cache-keepalive：從逐字稿找重寫、判斷失效位置的方法。用在 `report`。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵。
- `enabled`：總開關；`keepWarm`：只關保溫。
- `minContextTokens`：多大的上下文才保溫（預設 50000）。
- `wakeAfterSec1h`、`maxPings1h`：1 小時快取的喚醒時間與次數上限（預設 3300、8）。
- `wakeAfterSec5m`、`maxPings5m`：5 分鐘快取（預設 240、6）。
- `maxUsagePct`：5 小時用量到多少就停（預設 90）。
- `imageWarnAt`：圖片提醒門檻（預設 `[30, 50]`）。
- `warmOnQuestion`：回覆最後一行是問句時要不要保溫（預設 true）。
- `ignoreTaskTypes`：不算在等的背景工作類型（預設 `["dream", "auto-mode scan", "memory import"]`）。
- `debug`：把 hook 輸入存到 `state/debug/`（圖片內容不存）。

## 指令
- `node cli.js status`：設定與最近的 session（快取類型、上下文、在等什麼、本段保溫次數、圖片數）。
- `node cli.js log [行數]`：保溫、略過、圖片提醒的紀錄（`state/guard.log`）。
- `node cli.js report [天數]`：近幾天每次整段重寫的原因、多付多少，以及保溫花了多少。
- `node cli.js try [秒數]`：排一次實機喚醒測試（預設 60 秒），裝好或升級 Claude Code 後確認 `asyncRewake` 還有效。

## 安裝
- 用 toolkeeper：`node ~/.claude/toolkeeper/cli.js deploy cache-guard`。
- 手動：檔案放到 `~/.claude/cache-guard/`，在 `settings.json` 掛上 `deploy.json` 列的三個 hook；Stop 那個要加 `"asyncRewake": true` 與 `"timeout": 3600`。

## 已知限制
- 保溫那一輪會留在對話裡（一則系統提醒加一個「.」），每次約多 50 token。
- 只對互動模式有用；`claude -p` 結束時背景 hook 會被終止。
- 這一輪還沒結束的等待保不了溫：AskUserQuestion 的選項框、權限確認、前景子代理。這時 Stop 還沒觸發，Claude Code 也不會在工具等結果時送請求。
- 判斷「在等」需要 Stop 輸入有 `background_tasks` 和 `session_crons`（2.1.310 已確認有）；舊版沒有這兩欄時，只剩問句判斷。
- 問句判斷只看最後一行：回覆中間問、最後一行是陳述句的不算；反問句結尾也會被當成在等。
- 「快取被讀到就重新計時」是 Anthropic 目前的行為，不是保證；用 `report` 定期確認保溫後的請求真的讀到快取。
