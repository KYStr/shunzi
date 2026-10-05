# 0.1.0 實作與發布狀態

更新：2026-10-05。此紀錄區分工程完成與尚未通過的產品驗收。

最終工程驗證：公開專案 35 項單元測試、13 項 Edge 瀏覽器測試；私有後端 14 項測試通過。兩個 ZIP 連續建置的 SHA256 完全相同，原始碼與 ZIP 掃描通過。TypeScript 檢查通過。

## 已完成

- 同一份 TypeScript 核心建置 BYOK／託管兩套 Chrome／Edge MV3 套件；固定 Gemini 端點、版本驗證、600 ms／IME 保護、500 字元限制。
- 局部候選、還原／保留、記住原詞、鍵盤操作、一鍵暫停；自動修正能力存在，但 production policy 為空，首版維持建議模式。
- 金鑰只存本機 trusted extension storage；測試連線、刪除金鑰、保守用量估算與 FAQ。
- 私有 API 已獨立部署，HTTPS health 可達；MemoryMax=256M；六人 mock 併發通過、第七人限流。既有兩站 HTTP 200、既有 vhost hashes 與 learning process ID 未變。
- 評估語料 240 句人工構造範例，dev 40／holdout 200。holdout 含 100 錯句與 100 正確／歧義句。
- SQLite 費用預留及持久上限：本機評估 55＋託管評估 5＋試用 210，另留 30 緩衝；不確定結果保留預留。
- MIT、README／FAQ、資料流說明、Issue 模板、可重現 ZIP 與 SHA256SUMS；公開版專案與私有後端分開儲存。
- 真實 Edge MV3：storage 的 TRUSTED_CONTEXTS 確實拒絕 content-script world 讀金鑰；背景 worker 停止／喚醒、瀏覽器重啟、真正 runtime.reload、刪除金鑰的測試通過。全程使用 dummy credential、離線 fixture，無模型費用。
- Windows User/Machine PATH 的 registry type、長度、SHA256 與完整 Environment-key fingerprint 前後相同，ephemeral entry count 均為 0。

## 目前的阻擋

既有 Gemini API key 回傳 403 Consumer suspended。首次 smoke 的 NT$0.20 保守預留保留在私有帳本；此後沒有繼續付費請求。託管 API 尚未配置金鑰，請求於預留前回 503，帳本呼叫數及費用均為 0。

所以 **尚不能宣稱模型修復率 80%、自動修改正確率 99%、真實端到端 P95 ≤ 2 秒已達標**。mock 工程測試不代表模型通過。Jev 比較也尚未執行、未加入產品請求路徑。

## 待完成的發布門檻

1. 提供可用 Gemini 憑證後，在既有帳本內先 smoke／dev，凍結候選再跑 holdout，記錄真正瀏覽器端到端速度。
2. 你日常使用；補實際 ChatGPT 宿主與真實錯句的完整操作／品質驗收。目前已唯讀檢查現網輸入框標記；無頭瀏覽器直接存取逾時，改用正常 Edge 確認新撰寫器沒有舊 ID，需以 data-composer-input／data-composer-markdown 適配。尚未在你的真實會話中自動修改或送出文字。
3. 五人一週試用，至少三人使用四天且願意保留；至少一人只依 README 完成安裝與首次校對。
4. 依驗收結果決定允許自動修改的類型。未達標類型繼續只提示。
5. 完成門檻後公開 GitHub 儲存庫與首版 Release。

GitHub 儲存庫現階段保持私有，candidate ZIP 可供本機檢查，不等同已發布或已通過真人試用。詳細準則見 [EVALUATION.md](EVALUATION.md) 與 [PILOT.md](PILOT.md)。
