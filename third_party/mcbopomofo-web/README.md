# McBopomofo 字音資料的來源與散布聲明

核對日期：2026-10-05。本目錄保存順字所用詞庫的來源說明與授權；不能以順字根目錄的 MIT LICENSE 取代本目錄。

## 散布結論與必要檔案

依下列上游明示條款，固定 WebData 抽取的詞庫可隨順字散布，但須同時保留兩份 MIT 與 libtabe 詞庫的完整 BSD 聲明，不能把整份第三方詞庫只標為 MIT。包含詞庫的原始碼交付、npm 套件或 ZIP 必須附帶本目錄，且不得暗示上游作者或機構替順字背書。

- `LICENSE-McBopomofoWeb-MIT.txt`：Web 專案，Copyright 2022 and onwards The McBopomofo Authors。
- `LICENSE-McBopomofo-MIT.txt`：資料上游專案，Copyright 2011–2026 Mengjuei Hsieh et al.
- `LICENSE-libtabe-tsi-BSD.txt`：由 libtabe 官方 0.2.3 原始封裝的 `tsi-src/COPYING` 完整保存（僅移除檔尾多餘空白行）。包含 TaBE Project／Pai-Hsiang Hsiao 與中研院資訊所 Computer Systems and Communication Lab 的兩段 BSD 條件，以及 Chih-Hao Tsai 的版權聲明。
- `PROVENANCE.json` 與三份 `UPSTREAM-*`：固定來源、檔案雜湊、生成方式與歷史說明。

原文中的拼字、段落與歷史聯絡資訊保持原樣；libtabe 兩份文字僅移除檔尾多餘空白行。PROVENANCE.json 同時保留上游原始與散布檔案雜湊。不代表這些舊聯絡方式現在仍有效。

## 可核對的來源鏈

1. 順字固定使用 [McBopomofoWeb `e7bfa554…`](https://github.com/openvanilla/McBopomofoWeb/tree/e7bfa5547b92e08265bff2b23ecf0ada832d9270) 的 `src/McBopomofo/WebData.ts`，原始 SHA-256 為 `f4540be733eec5293569f6d968874748b9a9f22d611b2e299b45e143f796fa45`。
2. 該檔案最後更新的 [commit `e86a0d6…`](https://github.com/openvanilla/McBopomofoWeb/commit/e86a0d6131bcbb483ac38619bbde6bb3ef227133) 明示資料來源為 [McBopomofo PR #900](https://github.com/openvanilla/McBopomofo/pull/900)。PR 的資料分支 head 為 `d784d36e8b66cf8198c868e5529c70933a988678`，merge 為 `4cd2e6f2fc0795fa311e6283ef31f638c0dfed91`。
3. 固定版本的 [Web 建置說明](https://github.com/openvanilla/McBopomofoWeb/blob/e7bfa5547b92e08265bff2b23ecf0ada832d9270/tools/README.md) 與 [Makefile](https://github.com/openvanilla/McBopomofoWeb/blob/e7bfa5547b92e08265bff2b23ecf0ada832d9270/tools/Makefile) 說明由上游 `data.txt` 編碼生成 WebData。這是上游明示來源，這次核對沒有宣稱已由 PR #900 逐位元重建同一份 `data.txt`。
4. 上游固定提交的 [資料 README](https://github.com/openvanilla/McBopomofo/blob/4cd2e6f2fc0795fa311e6283ef31f638c0dfed91/Source/Data/README.md) 記載 `BPMFMappings.txt` 修改自 BSD 授權的 libtabe `tsi.src`。同提交的 [MIT LICENSE](https://github.com/openvanilla/McBopomofo/blob/4cd2e6f2fc0795fa311e6283ef31f638c0dfed91/LICENSE.txt) 亦已保存。
5. [libtabe 官方首頁](https://libtabe.sourceforge.net/) 指向 0.2.3 原始封裝。從[官方 SourceForge 下載位置](https://downloads.sourceforge.net/project/libtabe/libtabe/0.2.3/libtabe-0.2.3.tgz)核對的封裝 SHA-256 是 `878917c4c71d8eb21fb349eac25dfae60974608e41ab96ff86621a081d3b5cac`；本目錄的 BSD 文字直接抽自該封裝，不是由非官方文章重寫。

順字以 TypeScript AST 讀取資料字串，再 `JSON.parse`、解碼注音並保留 1～8 字漢字詞項，未執行上游程式。此固定抽取有 171,847 資料列，多讀音可能對應相同詞項；不是 171,847 個不重複詞。實際抽取腳本與資料雜湊須跟建置版本一併保留。

## 歷史限制與產品驗收

libtabe 的原始 README 說明早期詞表包含 Chih-Hao Tsai、IOME、Xcin 等來源，也記載後兩者的早期參考資料不完整。本次保存原文及上游明示的散布條款，沒有宣稱重新完成逐詞權利調查。此限制不能被刪掉或改寫成「全部由順字原創」。

上述授權核對解決隨包 notices 的要求，不代表詞庫品質、瀏覽器整合、成本門檻、真人試用或公開發布已通過。正式包仍須確認本目錄實際隨包、沒有私有資料，並通過產品既定驗收。
