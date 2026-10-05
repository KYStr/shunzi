# 0.2.0 Jev 方向與發布狀態

2026-10-05 後續紀錄。0.2.0 使用本機候選＋Jev，BYOK 不需 Gemini；下方 0.1.0 舊結果保留為歷史，不把舊 Gemini 403 當成新版阻礙。

固定詞庫的來源與授權已追到 WebData 更新 commit e86a0d6、McBopomofo PR #900，以及 libtabe 官方 0.2.3 `tsi-src/COPYING`。兩份 MIT、完整 BSD／版權及來源雜湊已保存在 `third_party/mcbopomofo-web`，可依上游條件隨詞庫散布，交付時須確認 ZIP 實際附帶。

v2 已在 dev 完成調整，採 `paragraph-phonetic-v2/mcbopomofo-e7bfa5547b92/loose-tones`，加入跨聲調及通用相鄰重複字刪除。凍結後完整 200 句 holdout 真 API 評測：錯句候選可達 88/100、候選漏失 12、選擇漏失 1，修復 **87/100（87%）**，修復 gate PASS；正確／歧義 100/100 保留。90 個提案修改中 87 個有效（96.67%），未達 99%，也不是產品 auto precision，**自動修改保持關閉**。該保留集沒有參與 v2 調整。

CLI pipeline P95 323 ms，不是瀏覽器端到端 P95。這次 holdout 估算 NT$0.55302282；本機帳本截至該筆累計 NT$1.06133536。原始結果位於 `.local/paragraph-eval-product-v2-holdout.json`，不公開個別案例或用它調整後冒充新驗收。

成本 gate **BLOCKED**：每次保守上限 NT$0.20 × 500 次 = NT$100，超過 paid 方案 NT$40 成本門檻，後端禁止 paid 開通。託管規劃 trial 自發碼起 7 天／100 次；後續 NT$99、自開通起 30 天／500 次，最多五人，不自動續費。尚未可販售、沒有真人付款證據。

新版工程已整合，最後復跑 TypeScript、56 項單元測試及 **17/17 瀏覽器測試**全部通過、無 skip；瀏覽器包含 16 項輸入框 fixture 與 1 項真實 Edge MV3 重啟／刪除流程。兩次建置的兩個 ZIP SHA-256 一致；最後 release:scan 通過 111 個原始碼／套件檔案，兩個 ZIP 的權限、校驗值、notices 與秘密掃描均通過。git diff --check 通過；Windows User／Machine 完整環境指紋未變，ephemeral PATH 項目為 0。

| 0.2.0 套件 | SHA-256 |
| --- | --- |
| BYOK | `31742cb258723925524e9246b4f0b9bfd616b77bc206e9f4f6a72b52f2da92bd` |
| 託管 | `8aa23f9c7a13481c3a279eb1b3774fb5d1df5f4816194e9b235352eb868f65c8` |

真實 Edge MV3 擴充套件＋真 Jev 在本機合成宿主頁完成 BYOK **30/30** 次預期候選，含 600 ms 停頓的 P95 為 **1,849 ms**，報告 `.local/browser-live.json`；託管路徑另完成 **6/6，P95 1,847 ms**。這是該測試頁的瀏覽器端到端結果，不能冒充實際 ChatGPT 網站、真實語音辨識或真人日常使用驗收。

託管 0.2.0 已部署於 `proof.040141.xyz`：實際 API 修正通過，相同成功 snapshot 重複請求回 409 且不重扣可用次數；原網站健康未變。本人測試可先開始，但本人兩天／五人七天、至少一位他人自助安裝、真實 ChatGPT 使用、成交及公開發布仍未完成。

成本已做真 API 觀測：`npm run cost:gate -- --live` 的 500 字、8 群、每群 6 候選樣本使用 7,917 input tokens，usage 估算 NT$0.01163799、耗時 1,149 ms；未知失敗保留 NT$0.20 的記憶體帳本 fixture 通過。單次觀測不證明 500 次最大費用，成本 gate 仍 false，`liveBillingVerified: false`，不收款。最新本機帳本 NT$1.62529916＋服務端 NT$0.049244＝NT$1.67454316，含保守未知預留，實際帳單尚未核對。

三張實機 PNG 已由主代理目視檢查，附於 [INSTALL](INSTALL.md)；[影片](assets/shunzi-demo.webm)已產生，實際 **21.32 秒、1120×820**，環境與分鏡見 [DEMO-VIDEO](DEMO-VIDEO.md)。它們均不等於他人自助安裝或真實 ChatGPT 驗收。

完整去識別聚合證據見 [evaluation-report.json](evaluation-report.json)。`v0.2.0-rc.1` 用作私人候選版標籤；公開發布仍受真人與產品門檻限制。乾淨 Git 原始碼封存（a7cffdb，重用固定詞庫與 lockfile 對應依賴）也重建出逐位元相同的兩個 ZIP。

## 0.1.0 與初版原型歷史紀錄

以下保留當時記載；其中「目前阻擋」「待完成」均指當時。新版目前待完成的是：實際 ChatGPT 驗收、本人兩天、他人自助安裝、五人七天、成本／paid 開通、真實成交與公開發布。

更新：2026-10-05。此紀錄區分工程完成與尚未通過的產品驗收。

既有基準工程驗證：公開專案 35 項單元測試、13 項 Edge 瀏覽器測試；私有後端 14 項測試通過。兩個 ZIP 連續建置的 SHA256 完全相同，原始碼與 ZIP 掃描通過。TypeScript 檢查通過。新增段落核心的驗證另列於下方，勿視為套件已切換 Jev。

## 段落候選核心原型

2026-10-05 後續完成 `@shunzi/core/paragraph`：以完整草稿產生具 UTF-16 位置的同音／跨詞候選，獨立固定版本 Jev Choice provider，原文／不確定選項、不可變候選快照、過期檢查、候選切換與還原、明確使用者選取才學習。此為命令列／核心原型；瀏覽器與私有 API 尚未接入，不開啟自動修改。

使用固定 McBopomofoWeb 詞庫提取 171,847 筆 1–8 字條目，保留多讀音，預設精確聲調。資料與來源記錄只存 .local，未進 Git 或 ZIP。這是重組已知輸入法做法，沒有訓練 AI 模型。操作及限制見 [PARAGRAPH-ENGINE.md](PARAGRAPH-ENGINE.md)。

6 句合成開發測試使用程式生成的候選，Jev `jev-1.13.0` 的最終預覽 6/6 符合預期：兩個錯句修正，四個正確／引用／保護姓名例句保留。這批例句參與開發，提示也明確解釋再／在，並非 holdout 品質驗收。單次候選生成 0.2–2.6 ms，Jev API 往返 245–422 ms，冷啟動索引 236 ms；非瀏覽器端到端 P95。

本輪 6 次估算 NT$0.01201431；沿用既有帳本累計 NT$0.41762824（含先前 Gemini 失敗保留的 NT$0.40）。未讀取 holdout；模型品質、自動修改資格、真人試用仍待驗證。

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

## 歷史：當時的阻擋

既有 Gemini API key 回傳 403 Consumer suspended。使用者存檔後重新測試，確認仍為同一把停用金鑰；兩次 smoke 合計保守預留 NT$0.40。託管 API 尚未配置金鑰，請求於預留前回 503，帳本呼叫數及費用均為 0。

使用者隨後提供 Jev 金鑰並澄清方向。Jev 認證及 8 次推論通過，手工候選判斷 7/8 符合預期，詳見 [JEV-PROBE.md](JEV-PROBE.md)。可優先研究本機候選＋Jev，Gemini 不是 Jev 的使用前提。目前 Jev 尚未接入套件或託管服務，也沒有完成 Gemini 對照實驗。

所以 **尚不能宣稱模型修復率 80%、自動修改正確率 99%、真實端到端 P95 ≤ 2 秒已達標**。mock 工程測試與少量手工候選測試都不代表產品通過。

## 歷史：當時待完成的發布門檻

1. 依澄清後的 Jev 方向先驗證本機候選涵蓋率與 Jev 選擇品質；凍結方案再跑 holdout，記錄真正瀏覽器端到端速度。只有比較 Gemini 方案時才需要可用的 Gemini 憑證。
2. 你日常使用；補實際 ChatGPT 宿主與真實錯句的完整操作／品質驗收。目前已唯讀檢查現網輸入框標記；無頭瀏覽器直接存取逾時，改用正常 Edge 確認新撰寫器沒有舊 ID，需以 data-composer-input／data-composer-markdown 適配。尚未在你的真實會話中自動修改或送出文字。
3. 五人一週試用，至少三人使用四天且願意保留；至少一人只依 README 完成安裝與首次校對。
4. 依驗收結果決定允許自動修改的類型。未達標類型繼續只提示。
5. 完成門檻後公開 GitHub 儲存庫與首版 Release。

GitHub 儲存庫現階段保持私有，candidate ZIP 可供本機檢查，不等同已發布或已通過真人試用。詳細準則見 [EVALUATION.md](EVALUATION.md) 與 [PILOT.md](PILOT.md)。
