# 通用語言（Ubiquitous Language）

狀態：**草案**（2026-10-26）。這張表是命名的依據：畫面、文件、程式、API 用同一個詞。新增或改名時，同一個 PR 更新這張表。標「建議」的程式名稱是重構後的名稱，現在的名稱寫在括號裡。

## 學習專案

| 中文     | 程式名稱      | 意思                                     |
| -------- | ------------- | ---------------------------------------- |
| 學習專案 | `Project`     | 一組教材、題目與練習的範圍，例如一次檢定 |
| 專案名稱 | `ProjectName` | 專案的名稱，不能是空字串                 |

## 教材來源

| 中文             | 程式名稱                                      | 意思                                                           |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------- |
| 教材             | `SourceDocument`                              | 匯入的一份 PDF、圖片或錄音                                     |
| 原始檔           | `SourceFile`                                  | 匯入的檔案、它的 SHA-256 與存放位置                            |
| 段落             | `DocumentChunk`                               | 教材切成的一段文字，題目由段落產生；錄音的段落有時間區間與翻譯 |
| 教材狀態         | `SourceDocumentStatus`                        | 處理中、取消中、已取消、可用，或處理失敗的原因                 |
| 擷取結果         | `PdfExtraction`（舊名 `PdfExtractionResult`） | 一次擷取得到的頁面、狀態與各階段耗時                           |
| 擷取頁面         | `ExtractedPage`                               | 擷取出的一頁文字與擷取方式                                     |
| 擷取方式         | `PdfExtractionMethod`                         | 內嵌文字、OCR、兩者混合，或沒有文字                            |
| 擷取政策         | `PdfExtractionPolicy`                         | 依擷取出的頁面決定教材狀態與擷取方式                           |
| 教材生命週期政策 | `SourceDocumentLifecyclePolicy`               | 教材什麼時候能產生題目、產生後是什麼狀態                       |
| 內容類型         | `ContentProfile`                              | 教材的題型慣例，例如 `jlpt_vocabulary`、`jlpt_grouped`         |
| 文字分類         | `TextClassification`                          | 一段文字判斷出的內容類型與判斷依據                             |
| 行範圍           | `LineMetadata`                                | 段落在原文的起訖行與行數                                       |
| 題目區塊         | `ParsedQuestionBlock`                         | 從教材文字切出的一題：題號、題幹、選項與所屬題組               |
| 題目形式         | `QuestionItemKind`                            | 一題是單獨的字彙題，還是題組裡的一題                           |
| Markdown 匯出    | `MarkdownProjection`                          | 可匯出的 PDF 與用來產生 Markdown 的段落                        |
| 教材無法提供     | `SourceDocumentUnavailable`                   | 教材不能以要求的形式提供，例如圖片沒有 Markdown                |
| 匯入作業         | `DocumentOperation`                           | 一次匯入、擷取、檢閱或重試，以及它還能不能取消                 |
| 作業狀態         | `DocumentOperationStatus`                     | 排隊、執行中、要求取消、已取消、成功、失敗                     |
| 作業階段         | `DocumentOperationPhase`                      | 上傳、處理、等待檢閱、轉錄、翻譯、取消中、寫入結果等           |
| 失敗後的教材狀態 | `DocumentFailureState`                        | 作業失敗或取消後，頁面教材留下的狀態，之後可以重試             |

## 擷取整合

| 中文             | 程式名稱                       | 意思                                               |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| 擷取             | capture                        | 交給 Capture Runtime 做 OCR 或語音轉文字的一次工作 |
| 擷取檢閱         | `CaptureReviewSession`         | 使用者檢查擷取結果、確認後才寫成教材段落           |
| 擷取檢閱狀態     | `CaptureReviewStatus`          | 等待、確認中、完成、取消，或失敗                   |
| 擷取檢閱的結束   | `CaptureReviewEnding`          | 要求檢閱進入完成、取消或失敗，以及結束時的事件序號 |
| 擷取檢閱無法轉換 | `CaptureReviewTransitionError` | 檢閱的狀態不允許這次轉換                           |

## 題目編寫

| 中文             | 程式名稱                      | 意思                                                            |
| ---------------- | ----------------------------- | --------------------------------------------------------------- |
| 題目草稿         | `QuestionDraft`               | 由段落產生或手動建立、可以編修的選擇題                          |
| 手寫草稿         | `NewQuestionDraft`            | 學習者自己寫的題目；引用出處時教材與段落要一起給                |
| 漢字讀音片段     | `ReadingSpan`                 | 詞典提供的題幹原文片段與平假名讀音                              |
| 讀音解答         | `ReadingSolution`             | 唯一讀音相符的選項、原文片段、讀音與固定的繁體中文解說          |
| 讀音詞典         | `ReadingLexicon`              | 提供題幹內含漢字片段讀音的 application port                      |
| 抽出題目         | `ExtractedQuestion`           | 模型從原文頁面抽出的題幹與選項，連同該頁原文，等待收錄判斷        |
| 題目收錄         | `QuestionAdmission`           | 一題抽出題目的收錄結果：清理後的題幹，或拒收原因                  |
| 拒收原因         | `AdmissionRejection`          | 抽出題目未被收錄的原因代碼；只記錄與量測，不進 API                |
| 讀音題節規則     | `section_asks_for_reading`     | 題目前同段落的指示含「読み方」或「よみかた」才可使用讀音詞典    |
| 題節指示         | `section_instruction`         | 同段落中題目前最近的題節指示，只在解析與草稿建議內部傳遞        |
| 草稿編修         | `DraftEdit`                   | 學習者對草稿的修正；只改有給的欄位，出處與狀態不變              |
| 草稿狀態         | `DraftStatus`                 | 草稿是否已核可；產生與手寫的草稿都直接核可                      |
| 答案來源         | `AnswerKeySource`             | 答案由學習者給、教材上的答案，或模型推論                        |
| 草稿來源段落     | `SourceChunk`                 | 交給寫草稿者的一段教材文字、頁碼與內容類型                      |
| 草稿建議         | `DraftSuggestion`             | 寫草稿者寫出、還沒存成草稿的一題                                |
| 待檢查的解析題   | `UnavailableDraftBlock`       | 解析到但沒能補完答案的題目，保留下來讓學習者檢查                |
| 產生結果         | `DraftGenerationResult`       | 一次產生得到的草稿建議與待檢查的解析題                          |
| 產生策略         | `DraftGenerationStrategy`     | 只用確定性解析，或解析加上語言模型                              |
| 寫草稿者         | `DraftGenerationProvider`     | 把段落寫成題目草稿的介面；`draft_writer_for` 依設定的供應者挑選 |
| 推理寫草稿       | `ReasoningDraftProvider`      | 請模型從段落找出完整的選擇題                                    |
| 快速首題         | `FastFirstDraftProvider`      | 請模型為一題解析到的題目補上答案與解說                          |
| Ollama 寫草稿者  | `OllamaDraftWriter`           | 經 JSON 對話請 Ollama 補答案與解說、或找出解析不到的題目        |
| 佔位草稿寫草稿者 | `PlaceholderDraftWriter`      | 假供應者用的固定草稿，讓 app 與測試不需要模型也能跑             |
| 產生工作         | `DraftGenerationJob`          | 匯入教材後，為一個段落產生題目的背景工作（每個段落與策略一個）  |
| 產生工作狀態     | `DraftGenerationJobStatus`    | 等待、執行中、要求取消、已取消、成功、因模型或供應者跳過、失敗  |
| 手動產生作業     | `ManualDraftOperation`        | 學習者要求為整份教材產生題目；同一份教材同時只有一個進行中      |
| 手動產生作業狀態 | `ManualDraftOperationStatus`  | 排隊、執行中、要求取消、已取消、成功、失敗                      |
| 產生已取消       | `DraftJobCanceledError`       | 取消在開始提交前發生；產生的草稿不寫入                          |
| 產生不能取消     | `DraftJobNotCancellableError` | 已經開始提交草稿，不能再取消                                    |

## 練習與複習

| 中文         | 程式名稱                  | 意思                                                               |
| ------------ | ------------------------- | ------------------------------------------------------------------ |
| 練習         | `PracticeSession`         | 一次作答；模式有整份、隨機抽題、錯題重練                           |
| 練習狀態     | `PracticeSessionStatus`   | 進行中、完成（每題都答過）、放棄                                   |
| 練習模式     | `PracticeSessionMode`     | 隨機抽題、整份教材、錯題重練                                       |
| 練習題目     | `PracticeQuestion`        | 練習問的一題：開始時的快照，之後改草稿不影響已開始的練習           |
| 草稿狀態     | `QuestionDraftStatus`     | 練習只用已核可的草稿                                               |
| 選題         | `QuestionSelection`       | 新練習問哪些題、題數，以及隨機抽題的種子                           |
| 作答         | `PracticeAttempt`         | 對一題的一次作答與對錯                                             |
| 作答紀錄     | `AnsweredQuestion`        | 一次作答與當時問的題目；專案的作答紀錄由新到舊排列                 |
| 錯題         | `WrongAnswer`             | 最近一次作答答錯、待複習的題目                                     |
| 錯題總覽     | `WrongAnswerSummary`      | 目前的錯題、已訂正（答錯過、最近一次答對）的題數與最近一次答錯時間 |
| 重複答錯     | `RepeatedMiss`            | 答錯超過一次的題目                                                 |
| 錯題分組     | `WrongAnswerCluster`      | 依教材與頁碼分組的錯題與已訂正題數                                 |
| 練習規則違反 | `PracticeRuleViolation`   | 作答或開始練習違反規則，例如選項不在題目裡                         |
| 練習狀態衝突 | `PracticeSessionConflict` | 練習的狀態不允許這個要求，例如已放棄的練習不能再作答               |
| 解說         | explanation               | 由 LLM 產生、說明錯題的文字                                        |

## AI 供應

| 中文               | 程式名稱                                   | 意思                                                           |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| 供應者             | `LLMProvider`                              | 使用者設定的語言模型：哪個供應者、哪個模型、目前能不能用       |
| 供應者健康狀態     | `ProviderHealth`                           | 供應者與模型是否可用、為什麼不能用、用哪個設定檔與執行模式     |
| 供應者能力         | `provider_capability`                      | 供應者除了回報健康之外能做的事；延遲建立的供應者在查詢時才建立 |
| JSON 對話          | `JsonChatProvider`、`JsonChat`             | 以 JSON 模式和設定的模型對話；一個工作階段內模型只檢查一次     |
| 結構化 JSON        | `StructuredJsonGenerationProvider`         | 依 JSON schema 產生一個候選結果，原樣回傳不修正                |
| 模型下載           | `ModelDownloadProvider`                    | 使用者確認後下載設定的模型                                     |
| 模型上線檢查       | `ModelOnboardingProvider`                  | 下載前檢查執行環境、下載後確認模型能回應                       |
| 產生歸屬           | `GenerationAttributionProvider`            | 最近一次成功的產生實際用了哪個供應者與模型                     |
| 釋放資源           | `ResourceReleasingProvider`                | 串流產生工作結束後讓模型卸載                                   |
| 串流參數           | `StreamingGenerationOptionsProvider`       | 串流產生時供應者自己的呼叫參數，例如用完就卸載模型             |
| 產生時才啟動       | `StartsOnGenerationProvider`               | 產生時才啟動還沒執行的供應者執行環境                           |
| 需要安裝的執行環境 | `RuntimeInstallationProvider`              | 供應者需要在本機安裝的執行環境（Ollama）                       |
| 延遲建立的供應者   | `LazyLLMProvider`                          | 第一次用到時才依設定建立的供應者                               |
| 供應者偏好         | `LLMProviderPreference`                    | 使用者設定的偏好：自動、Ollama 或假供應者                      |
| 供應者選擇         | `LLMProviderSelection`、`select_provider`  | 偏好選中的供應者、實際使用的供應者，以及它需要安裝什麼         |
| 執行模式           | `LLMExecutionMode`                         | 模型用加速器（自動）或只用 CPU                                 |
| 模型設定檔         | `OllamaModelProfile`                       | 一個 Ollama 模型與它的參數、需要的記憶體與磁碟空間             |
| 設定檔選擇         | `OllamaProfileSelection`                   | 為這台機器選中的設定檔、備用設定檔與原因                       |
| 機器盤點           | `MachineInventory`、`MachineInventoryRead` | CPU、記憶體、儲存空間與加速器；用來選設定檔與執行模式          |
| 裝置政策           | `OllamaDevicePolicy`                       | 依機器盤點決定的 Ollama 執行裝置目標、後端與環境變數           |
| 伺服器協調者       | `OllamaServerCoordinator`                 | 管理 Cert Prep 啟動與擁有的 Ollama 伺服器生命週期、環境與重啟 |
| 裝置執行狀態       | `DeviceExecution`                          | 模型載入時日誌解析驗證出的實際裝置、後端、層數與驗證狀態       |

## 執行環境

| 中文             | 程式名稱                      | 意思                                                           |
| ---------------- | ----------------------------- | -------------------------------------------------------------- |
| 執行環境安裝     | `RuntimeInstallationJob`      | 安裝或檢查 Ollama 執行環境與語言模型等本機元件的背景工作 |
| 執行環境安裝目標 | `RuntimeInstallationTarget`   | 安裝工作的需求種類、供應者名稱與模型                           |
| 執行環境安裝階段 | `RuntimeInstallationPhase`    | 安裝工作的技術階段，例如排隊、執行中、提交中等                 |
| 執行環境安裝進度 | `RuntimeInstallationProgress` | 安裝工作的進度更新：說明、完成度、總量、階段與是否可取消       |
| 執行環境安裝快照 | `RuntimeInstallationSnapshot` | 執行環境安裝工作對外的序列化檢視                               |
| 執行環境安裝已取消 | `RuntimeInstallationCanceledError` | 安裝工作已取消而拒絕狀態轉換的錯誤                             |
| 執行環境需求種類 | `RuntimeRequirementKind`      | 可安裝的本機相依類別，例如 Ollama 執行環境或模型               |
| 執行環境安裝狀態 | `RuntimeInstallationStatus`   | 執行環境安裝工作的生命週期狀態                                 |
