# 段落候選核心：本機詞庫＋可替換選擇器

這是獨立的 TypeScript 核心：把輸入法常用的字音反查、注音候選、詞頻排序與使用者選詞偏好，重組為「已成文段落的局部修正候選」。它沒有訓練、微調或蒸餾 AI，也沒有搬入整套 McBopomofo 輸入法。

核心先產生有限候選；Jev 只負責看上下文、選候選或保留原文，可以替換成其他選擇器。0.2.0 已將此流程接入瀏覽器套件與託管服務，BYOK 只需 Jev key，不需 Gemini。舊 0.1.0 Gemini 包是歷史基準，不是新版使用前提；工程、真人與發布進度見 [STATUS](STATUS.md)。核心產出的修改一律標為 `suggest`，不開自動修改。

本輪凍結版本為 `paragraph-phonetic-v2/mcbopomofo-e7bfa5547b92/loose-tones`：production 使用跨聲調候選，並加入通用相鄰重複字刪除。完整保留集修復 87/100，通過修復 gate；提案精確率 96.67% 未達 99%，成本及真人 gate 仍未通過。

## 執行方式

在專案根目錄、依現有開發環境使用 Node 24 執行：

```sh
npm run paragraph:prepare
npm run paragraph:demo
```

`paragraph:prepare` 是套件建置前必要步驟，下載固定版本的公開詞庫及來源說明，驗證來源雜湊，再建立 `.local/mcbopomofo/lexicon.json`。這一步需要網路，但不呼叫付費模型。已有快取仍會驗證版本／雜湊；格式或雜湊不符就停止，不悄悄改用最新版。

`paragraph:demo` 預設完全離線，使用六個人工構造的開發例句。它會列出本機候選、以已知答案檢查 `expectedReachable`，並輸出 `.local/paragraph-offline.json`。`expectedReachable` 只回答「候選中能否組成預期答案」，不能當成模型選對或自動修正正確的證據。

需要測試 Jev 時，須先在本機配置 `.local/jev-api-key.txt`，再執行：

```sh
npm run paragraph:demo -- --live
```

這個命令會產生付費 API 請求，使用既有 `.local/eval-budget.sqlite`，與 Gemini 等本機評測共用 **NT$55 累計上限**，不建立另一筆 NT$55 預算，也不清除歷史支出。每次請求先預留 NT$0.20；成功後依回傳用量估算結算，失敗保留預留並停止本次執行。回報費用超過預留或出現無效費用值時，帳本的持續性保護會阻止新請求；缺少費用資料則保守保留整筆預留。沒有候選的例句不呼叫 Jev。上述估算不能取代供應商帳單或帳戶額度限制。

整體預算仍是本機評測 NT$55、託管驗收 NT$5、試用 NT$210、緩衝 NT$30。不要刪除或重建帳本來重跑測試。`--live` 報告寫入 `.local/paragraph-live.json`；兩種報告都只是開發 smoke，並非保留驗收集或真實使用者測試。

## 固定詞庫與資料來源

準備腳本從 McBopomofoWeb 的 `src/McBopomofo/WebData.ts` 抽取資料，固定值如下：

| 項目 | 值 |
| --- | --- |
| 上游提交 | `e7bfa5547b92e08265bff2b23ecf0ada832d9270` |
| 原始檔 SHA-256 | `f4540be733eec5293569f6d968874748b9a9f22d611b2e299b45e143f796fa45` |
| 詞庫版本 | `mcbopomofo-e7bfa5547b92` |
| 此固定來源抽取的資料列 | 171,847 entries；不是不重複字詞數，同一字詞可以有不同讀音 |

抽取流程是 TypeScript AST 找出 `source` 的 `NoSubstitutionTemplateLiteral`，再以 `JSON.parse` 解析，解碼注音並篩出 1～8 個漢字的資料列。不 `eval`、匯入或執行上游程式。輸出格式為：

```ts
interface LexiconEntry {
  text: string;
  readings: string[]; // 每個漢字對應一個帶聲調的注音音節
  score: number;      // 上游排序分數，不是正確率
}
```

原始快取與 `SOURCE.json` 放在 `.local/mcbopomofo/`，`.local` 本身不提交 Git 或打包。0.2.0 建置會把經版本／雜湊驗證的派生詞庫隨兩種 ZIP 附帶，同時必須附上 `third_party/mcbopomofo-web` 的完整 notices。可重現的來源與雜湊以 `scripts/prepare-paragraph-lexicon.ts` 為準。

授權要分開看程式與資料：

- McBopomofoWeb 的程式專案有 [MIT 授權文字](https://github.com/openvanilla/McBopomofoWeb/blob/e7bfa5547b92e08265bff2b23ecf0ada832d9270/LICENSE.txt)。準備腳本將其保存為 `LICENSE-Web-MIT.txt`。
- Web 詞庫由 McBopomofo 的 `data.txt` 產生，來源建置方式見固定版本的 [tools/README.md](https://github.com/openvanilla/McBopomofoWeb/blob/e7bfa5547b92e08265bff2b23ecf0ada832d9270/tools/README.md)。生成檔沒有完整標頭，不代表來源聲明可以省略。
- McBopomofo 的[固定資料說明](https://github.com/openvanilla/McBopomofo/blob/4cd2e6f2fc0795fa311e6283ef31f638c0dfed91/Source/Data/README.md) 記載 `BPMFMappings` 源自 BSD 授權的 libtabe `tsi.src` 並經修改。

2026-10-05 已追到 WebData 更新 `e86a0d6` 明示的 McBopomofo PR #900，並由 libtabe 官方 0.2.3 原始封裝保存完整 `tsi-src/COPYING`。依上游條件可隨包散布，但不能只標 MIT；兩份 MIT、BSD／版權、固定來源及歷史限制見 [third-party 說明](../third_party/mcbopomofo-web/README.md)。沒有宣稱逐詞權利調查或由上游 PR 逐位元重建資料。正式包仍要檢查 notices 確實附帶。

## 核心流程與介面

入口為 `src/core/paragraph/index.ts`；套件建置提供 `@shunzi/core/paragraph` 匯出。資料、候選、review 與個人偏好是獨立介面，Jev 不參與本機字音索引的建立。

1. `PhoneticLexicon` 建立漢字到多個讀音的反查表、注音 trie 與詞頻分數索引。
2. `prepareParagraph` 掃描漢字區段，用各字可能讀音找詞庫候選，根據原文最佳斷詞分數、改動字數與本機選詞偏好排序。
3. 本機先去重、截斷候選並取捨重疊區段，產生不可變的 `CandidateBatch`。
4. 選擇器可回傳每組的候選 ID，選原文或表示不確定；`reviewParagraph` 由原文快照生成 review。
5. 使用者明確選取候選後，才可透過 `learnParagraphChoice` 產生更新的個人偏好。

| 介面 | 用途與重要約束 |
| --- | --- |
| `new PhoneticLexicon(entries, dataVersion, options?)` | 建立本機索引。類別預設精確聲調；0.2.0 production／CLI 明確傳入 `allowToneChanges: true`，採跨聲調候選。 |
| `lexicon.readingsFor(character)` | 回傳詞庫已知的多個讀音，沒有用單一 `getReading` 丟棄多音字。 |
| `lexicon.matches(chars, start)` | 從漢字陣列指定位置列出字音相符的詞庫資料，並回報搜尋是否截斷。 |
| `lexicon.scoreOf(text)` / `scoreOriginal(text)` | 取得詞分數或原文最佳詞庫斷詞分數；不是語意判斷或 confidence。 |
| `prepareParagraph(request, lexicon, profile?)` | 產生候選批次，保留草稿版本、原文、管線版本及偏好版本。 |
| `snapshotCandidateBatch(batch)` / `validateCandidateBatch(batch)` | 複製、凍結或驗證批次，檢查原文區段、候選、ID、重疊與字元邊界。 |
| `reviewParagraph(batch, choices?)` | 依候選 ID 產生預覽與 `suggest` edits。未選的區段保留原文。 |
| `assertCurrentBatch(batch, current, profileRevision)` | 新結果進入 review 前檢查草稿文字、版本、保護詞與偏好版本，捨棄過期結果。 |
| `changeReviewOption(review, groupId, optionId, current)` | 已顯示 review 內更換候選；選 `keep` 還原。驗證目前文字仍對得上該 review。 |
| `learnParagraphChoice(profile, batch, choice, eventId, origin)` | 只在 `origin: 'user'` 且事件尚未處理時更新偏好。 |
| `createJevChoiceRequest(batch)` / `selectWithJev(batch, key, options?)` | Jev 接入層；建立請求及驗證候選選擇結果，可注入 fetch 或取消訊號。 |
| `reviewJevSelection(selection, current, profileRevision)` | 驗證 Jev 結果及批次版本，通過後才生成 review。 |

`CandidateGroup.start/end` 是原始草稿的 **UTF-16** 半開區間 `[start, end)`，符合 JavaScript 字串切片；掃描詞長則以 Unicode code point 計數，不切斷 surrogate pair。每組包含原文 `keep` 與候選 ID，修改及切換都從同一原文快照重建，不把上一次預覽當成新的原文。

Jev 目前使用 `jev-1.13.0`。遠端請求會包含完整當前草稿、候選，以及草稿內實際出現的保護詞，讓它判斷上下文；「本機產生候選」不代表 `--live` 不傳送草稿。Jev 只能從合法 ID 選擇，不能自行生成替換文字。它也可以回 `unsure` 保留原文。替換 Jev 時，可沿用相同候選批次及 `ChoiceDecision[]`，並保留版本與回傳值驗證。

## 個人化與還原

個人化是本機選詞權重，不是更新 AI 模型。只有使用者明確選取才學習；模型自行選出的候選、使用者未回應、重複事件均不增加偏好。明確選擇 `keep` 也可以表示偏好保留原字詞。偏好資料只含選詞權重、版本與去重事件 ID，不包含整段草稿或 API 金鑰。

核心仍是純函式介面，由呼叫端保存並傳回偏好。0.2.0 背景程序已接入本機 `paragraphProfile`，設定頁提供「清除學習偏好」；明確選取可學習，還原會撤回該次偏好增量。這些接線須納入新版瀏覽器驗收，不能以本文件取代實機結果。CLI demo 沒有累積真人學習。

學習後的偏好版本改變，會讓尚未套用的新結果失效；但**不會因此阻擋已顯示 review 的候選切換或還原**。已顯示 review 的操作依其文字與草稿快照驗證。若使用者已繼續編輯，則要求重新校對，以免覆寫新輸入。

## 目前限制

- 每則草稿沿用共用核心的 500 字元上限；詞庫項目及候選區段為 1～8 個漢字。最多保留 8 個互不重疊區段，每組最多 6 個選項，包含原文；這是核心上限，不是已完成的 UI 顯示規格。
- 保留詞庫已知的多音字讀音，v2 production 允許聲調差異。多音字或跨聲調組合仍可能不合語境，需要後續選擇；缺字或缺讀音就無法涵蓋。
- 跨詞候選可從連續漢字重組，不受原輸入法原先斷詞束縛；但仍須在詞庫、長度及改動上限內。同音替換外，v2 加入相鄰重複字刪除，仍保留原文讓選擇器判斷語法上的合理重複。任意省略字、多字 ASR 錯誤及完整模糊音模型尚未涵蓋。
- 候選以字典分數差、改動量和偏好排序，詞頻及 `rankScore` 都不是 confidence。較高分不代表可以自動修改。
- 重疊區段在本機先取捨，再交給 Jev；被排除的候選不會由 Jev 比較。`truncated: true` 表示曾遇到候選、區段或搜尋限制，不能當成已完整找出所有修法。空候選也不代表原文一定正確。
- 既有保護區段與明確 `protectedTerms` 會排除部分候選，但這不是完整人名辨識器。保護詞、引用錯字、程式碼與中英混用仍需實際驗證。
- CLI 的 `indexMs`、`candidateMs`、`apiMs` 是分段診斷值，未涵蓋瀏覽器輸入、600 毫秒等待、UI 顯示與網路排程，不能視為真實端到端 P95。
- 六句 smoke、離線已知答案可達性及 mock 測試都不能證明修復率 80%、自動修改正確率 99%，也不能代替保留驗收集與一週試用。因此原型維持建議模式。

## v2 驗證與成本

凍結後完整 200 句 holdout：100 錯句候選可達 88，候選漏失 12，選擇漏失 1，最終修復 87（87%）；100 正確／歧義句全數保留。90 個提案局部修改中 87 個有效（96.67%），未達 99%，也不是產品自動修改的精確率，所以維持建議模式。該 holdout 未參與 v2 調整；不能把看過結果後的改版沿用此驗收。

pipeline P95 為 323 ms，僅 CLI 核心／API 診斷。此次估算 NT$0.55302282、截至該筆本機累計 NT$1.06133536。成本 gate 仍失敗：NT$0.20 × 500 = NT$100 > NT$40，paid 不開通。詳細定義與 `npm run paragraph:eval -- --split dev|holdout --label UNIQUE --live` 使用條件見 [EVALUATION](EVALUATION.md)；不要把 `dev|holdout` 當成可直接執行的字面參數。

新版工程最後通過 TypeScript、56 單元、17/17 瀏覽器（16 fixture＋1 Edge lifecycle），兩次 ZIP 雜湊一致，111 個檔案及兩包發布掃描通過。真實 Edge MV3＋Jev 在本機合成宿主完成 BYOK 30/30、P95 1,849 ms，託管 6/6、P95 1,847 ms，均含 600 ms 停頓；這是該測試頁端到端結果，不是實際 ChatGPT 網站或語音實測。託管 0.2.0 已部署並通過真 API 修正、重複 409 不扣次；本人兩天、五人七天與實際 ChatGPT 日常驗收仍未完成。

成本真 API 另有 500 字／8 群／6 選項樣本：7,917 input tokens，估 NT$0.01163799、1,149 ms；未知失敗保留預留的 fixture 通過，但單次觀測不是 500 次硬上界，paid gate 仍 false。最新帳本合計 NT$1.67454316，含保守預留且未核對供應商帳單；完整聚合紀錄見 [evaluation-report.json](evaluation-report.json)。

## 初版原型驗證歷史

2026-10-05 整合檢查與開發試驗。此紀錄區分程式行為檢查與模型品質驗收。

| 驗證項目 | 結果與證據 |
| --- | --- |
| TypeScript 與段落核心 focused tests | TypeScript 通過；新增 13 項段落測試，全部 48 項單元測試通過 |
| 建置、套件回歸與發布掃描 | 核心及兩種套件建置通過；13 項 Edge 瀏覽器測試通過；兩個 ZIP 與基準 SHA256 相同，來源／ZIP／憑證掃描通過。瀏覽器測試驗證既有路徑回歸，不代表新核心已接入 |
| 固定詞庫的離線 smoke | 6 句的預期結果皆能由自動產生的候選組成；包括 2 個錯句與 4 個保留原文的案例，不能把後者計為錯句召回 |
| Jev 付費開發 smoke | 實際完成 6 次，模型均為 jev-1.13.0；6 個預覽符合預期。候選生成 0.2–2.6 ms，API 245–422 ms，該次冷索引 236 ms；非端到端 P95 |
| 保留集品質、瀏覽器端到端延遲與使用者試用 | 本文件未提供通過證據 |

兩個錯句為「請把這兩段連載憶起，整理成一份筆記。」及「我現在在家，明天在回覆你。」；結果分別修正為「連在一起」和第二句最後一個「再」。另外四句包含正確的「小說連載」「憶起往事」、引用錯字與指定的保護姓名。這些例句已參與開發，提示中也有再／在的用法說明，不能作為獨立驗收集。

本輪費用估算 NT$0.01201431，沿用帳本累計 NT$0.41762824，含之前 Gemini 失敗的 NT$0.40 保守預留。沒有讀取或調整 holdout。原始合成測試報告在 `.local/paragraph-live.json`，不包含金鑰。
