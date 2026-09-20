## プロジェクト概要
NotebookLM的ローカルAIシステム「Ankel」を再構築する。
GitHub Pagesで動作し、Chrome/Edge専用（WebGPU対応ブラウザ）。
**外部へのデータ送信は一切行わない。**

---

## 技術スタック（確定）

| 役割 | 技術 | 理由 |
|---|---|---|
| LLM推論 | `@mlc-ai/web-llm` + WebGPU | Chrome/Edge限定・GPU高速・完全ローカル |
| 検索エンジン | IndexedDB + 多段スコアリング | ローカル・高速 |
| ホスティング | GitHub Pages | 無料・静的 |
| モデル配布 | WebLLM公式CDN（HuggingFace） | モデルファイルをリポジトリに入れない |

**廃止するもの：**
- `ai-worker.js`（WebWorkerは不要。WebLLMは内部でWorkerを自前管理する）
- `coi-serviceworker.js`（WebLLMはSharedArrayBuffer不要）
- `wllama`関連のコード（MemoryCacheManager含む全て）

---

## ファイル構成（最終形）

```
ankel/
├── index.html     # UI・エントリーポイント
├── style.css      # デザイン（既存を流用・一部修正）
├── main.js        # 全ロジック統合（検索・生成・DB・UI）
└── README.md      # 運用ガイド
```

**削除するファイル：**
- `ai-worker.js`
- `coi-serviceworker.js`

---

## index.html の仕様

### 変更点
- `coi-serviceworker.js` の登録スクリプトを**削除**
- `<script src="./main.js"></script>` を `<script type="module" src="./main.js"></script>` に変更
  - WebLLMはESMのみ対応のため

### 維持する要素（既存から流用）
- favicon（ヘイローSVG data URI）
- ヘイローSVGアイコン（全箇所）
- インポート画面（`#import-screen`）のHTML構造
- プログレスバー（`#import-progress-wrap`）
- ヘッダー（`#header`）：ヘイローアイコン・タイトル・データ更新ボタン・モデルセレクタ・ステータス
- チャットエリア（`#chat-area`、`#messages`、`#input-area`）
- モデルロードオーバーレイ（`#model-overlay`）
- データ更新モーダル（`#update-modal`）
- トースト（`#toast`）

### モデルセレクタの選択肢を以下に変更

```html
<select id="model-select">
  <option value="Llama-3.2-3B-Instruct-q4f32_1-MLC">標準 — Llama-3.2-3B (推奨)</option>
  <option value="Llama-3.2-1B-Instruct-q4f32_1-MLC">高速 — Llama-3.2-1B (軽量)</option>
  <option value="gemma-2-2b-it-q4f32_1-MLC">校閲特化 — Gemma-2-2B</option>
</select>
```

### 追加するUI要素

**WebGPU非対応警告バナー**（`<body>`直後に追加）：
```html
<div id="webgpu-warning" style="display:none;">
  ⚠ このブラウザはWebGPUに対応していません。Chrome 113+ または Edge 113+ を使用してください。
</div>
```

**停止ボタン**は既存のまま維持（`id="stop-btn"`）

---

## main.js の完全仕様

### 定数・設定

```js
const APP_VERSION    = '2025-05-23-r9';
const DB_NAME        = 'ankel_kb';
const DB_VERSION     = 3;
const STORE_PAGES    = 'pages';
const STORE_META     = 'meta';

// WebLLM CDN（モデルのconfig.jsonの場所）
const WEBLLM_CDN = 'https://huggingface.co/mlc-ai/';
```

### IndexedDB（既存コードをそのまま流用）

以下の関数を**そのまま維持**する：
- `openDB()`
- `dbGetAll(storeName)`
- `dbPut(storeName, record)`
- `dbPutMany(storeName, records)`
- `dbClear(storeName)`
- `countPages()`
- `getAllPagesMeta()`
- `importScrapboxJSON(json, onProgress)`

**`parseTitleMeta(title)`** も維持。仕様：
- `yyyy-tag-subtag-desc-subdesc` 形式をパース
- サブ要素は省略可能
- 年度なし・形式不正はベストエフォート解析

### 検索エンジン（既存を改善）

**`searchKeyword(query, topK = 10)`** を以下の仕様で再実装：

```
スコアリング：
1. クエリをトークン分割（スペース・句読点・助詞区切り、2文字以上）
2. 各トークンに対して：
   - タイトル完全フレーズ一致: ×15
   - タグ一致: ×8
   - サブタグ一致: ×5
   - description一致: ×6
   - subdesc一致: ×4
   - 本文出現回数: ×1（出現ごと）
   - 年度一致: ×3
3. スコア合計でソート、上位10件を返す
4. スコア0のものは除外

戻り値の各要素に score フィールドを含める
```

**`expandQuery(query)`** を新規追加：
```
同義語・表記ゆれを展開する関数。
入力クエリから関連キーワードを生成してトークン配列を拡張する。
例：「生徒総会」→「生徒総会, 総会, 全体会議」
例：「予算」→「予算, 会計, 収支, 決算」
例：「引き継ぎ」→「引き継ぎ, 引継, 引継書, 申し送り」

同義語マップをオブジェクトとして定義し、
クエリ内のキーワードにマッチすれば展開語を追加する。
生徒会に特有の業務語彙（会計・議事録・文化祭・体育祭・総会等）を中心に定義。
```

### WebLLM統合

#### インポート（ESMモジュールトップレベル）

```js
import * as webllm from 'https://esm.run/@mlc-ai/web-llm';
```

**注意**: `esm.run` はESM変換プロキシ。WebLLMのnpmパッケージをESM形式で提供する。
もし `esm.run` が動作しない場合のフォールバック：
```js
import * as webllm from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm';
```

#### WebGPU対応チェック

```js
async function checkWebGPU() {
  if (!navigator.gpu) {
    document.getElementById('webgpu-warning').style.display = 'block';
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter');
    return true;
  } catch {
    document.getElementById('webgpu-warning').style.display = 'block';
    return false;
  }
}
```

#### エンジン管理

```js
let engine = null;        // webllm.MLCEngine インスタンス
let modelLoaded = false;
let currentModelId = 'Llama-3.2-3B-Instruct-q4f32_1-MLC';
let isGenerating = false;
let generationAbortController = null;
```

#### `loadModel(modelId)` 関数

```js
async function loadModel(modelId) {
  // 1. ステータス表示・オーバーレイ表示
  // 2. 既存engineがあれば engine.unload() してから再生成
  // 3. engine = new webllm.MLCEngine()
  // 4. engine.setInitProgressCallback((report) => {
  //      overlayText.textContent = report.text;
  //      overlayBar.style.width = (report.progress * 100) + '%';
  //      console.log('[Ankel] モデルロード:', Math.round(report.progress * 100) + '%', report.text);
  //    })
  // 5. await engine.reload(modelId)
  // 6. modelLoaded = true
  // 7. オーバーレイ非表示・ステータス更新
}
```

#### `sendMessage()` 関数（生成部分）

WebLLMのOpenAI互換APIを使う：

```js
// ストリーミング生成
generationAbortController = new AbortController();

const stream = await engine.chat.completions.create({
  messages: [
    { role: 'system', content: SYSTEM_PROMPT + contextBlock },
    ...chatHistory,
    { role: 'user', content: userText }
  ],
  stream: true,
  temperature: 0.3,      // 低め→安定・繰り返しなし
  top_p: 0.9,
  max_tokens: 600,
  frequency_penalty: 0.3, // 繰り返し抑制
  presence_penalty: 0.1,
});

let fullText = '';
for await (const chunk of stream) {
  if (generationAbortController.signal.aborted) break;
  const delta = chunk.choices[0]?.delta?.content ?? '';
  fullText += delta;
  bubbleBody.textContent = fullText;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
```

**停止ボタン** は `generationAbortController.abort()` を呼ぶだけ。

#### システムプロンプト

```js
const SYSTEM_PROMPT = `あなたは生徒会総務の業務補佐システム「Ankel（アンケル）」です。
以下のルールに従って回答してください：
- Scrapboxの過去資料（参考資料として提供される）を必ず参照し、具体的な情報を引用すること
- 資料に記載のない情報は「資料には記載がありません」と明示すること
- 回答は簡潔・具体的・日本語で
- 校閲・資料作成・問題解決を誠実にサポートすること
- 繰り返しや冗長な表現を避けること`;
```

#### コンテキストブロック生成

```js
function buildContextBlock(pages) {
  if (!pages || pages.length === 0) return '';
  let block = '\n\n【参考資料（Scrapbox過去ページ）】\n';
  pages.forEach((p, i) => {
    block += `\n--- 資料${i + 1}: ${p.title} (スコア: ${p.score}) ---\n`;
    // 本文は先頭800文字まで
    block += (p.body || '').slice(0, 800) + '\n';
  });
  return block;
}
```

### チャット履歴管理

```js
// チャット履歴はUIのメッセージ履歴とは別に管理
// { role: 'user'|'assistant', content: string }[]
// 最大10往復（20件）でスライドさせる（コンテキスト長の管理）
let chatHistory = [];
const MAX_HISTORY = 20;

function addToHistory(role, content) {
  chatHistory.push({ role, content });
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory = chatHistory.slice(-MAX_HISTORY);
  }
}
```

### データ更新フロー（既存と同じ）

`handleJSONFile(file, mode)` 関数はそのまま維持。
インポート・更新モーダルの動作は変更なし。
`embeddingReady` の概念は削除（WebLLMではEmbeddingを使わない）。

### 情報源表示（既存と同じ）

`makeScrapboxUrl(title)`・`appendMessage()` はそのまま維持。
`src-link`・`src-chip` のスタイルは既存CSSを流用。

---

## style.css の変更点

**変更なし**でよい。既存のCSSを全てそのまま使う。

唯一追加するのは WebGPU警告バナーのスタイル：

```css
#webgpu-warning {
  background: #3a1a1a;
  border-bottom: 1px solid #e06c6c;
  color: #e06c6c;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 0.5rem 1.25rem;
  text-align: center;
}
```

---

## 実装の注意事項

### 1. ESM module として実行する
`main.js` は `<script type="module">` で読み込む。
トップレベルに `import * as webllm from '...'` を記述。

### 2. WebLLMのモデルIDについて
WebLLM公式の対応モデルIDは以下で確認できる：
https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
または `webllm.prebuiltAppConfig.model_list` で実行時に取得できる。

### 3. モデルの初回ダウンロードとキャッシュ
WebLLMは初回ダウンロードしたモデルを **CacheStorage**（ServiceWorkerのキャッシュとは別）に自動保存する。
OPFSやIndexedDBは使わないため、容量問題は発生しない。

### 4. SharedArrayBuffer不要
WebLLMはSharedArrayBufferを必要としない。
`coi-serviceworker.js` は不要なので削除してよい。
`index.html` から `navigator.serviceWorker.register('./coi-serviceworker.js')` を削除する。

### 5. engine.reload() の挙動
同じ `engine` インスタンスに対して別モデルをロードする場合は `engine.reload(newModelId)` を呼べばよい。
インスタンスの再生成は不要。

### 6. ストリーミングのAbort
`for await (const chunk of stream)` のループ内で `abortController.signal.aborted` を確認して `break` する。
WebLLMのストリームはAbortSignalに直接対応していないため、このパターンで実装する。

### 7. コンソールデバッグ
以下のフォーマットでログを出す：
```
[Ankel vX.X.X-rN] メッセージ
[Ankel DB] メッセージ
[Ankel Search] メッセージ
[Ankel LLM] メッセージ
```

---

## 実装順序（推奨）

1. `index.html` から coi-serviceworker 登録を削除し、`script type="module"` に変更
2. `style.css` に WebGPU警告バナーのCSSを追加
3. `main.js` を以下の順で実装：
   a. ESM import 文（webllm）
   b. 定数・状態変数
   c. IndexedDB関数群（既存コピー）
   d. `parseTitleMeta()`（既存コピー）
   e. `expandQuery()` 新規実装
   f. `searchKeyword()` 改善版実装
   g. `checkWebGPU()`
   h. `loadModel()`
   i. `buildContextBlock()`
   j. `sendMessage()`（WebLLMストリーミング）
   k. `stopGeneration()`
   l. UI初期化・イベントリスナー群（既存コピー）
   m. インポート処理（既存コピー）
   n. データ更新モーダル（既存コピー）
   o. ユーティリティ関数群（既存コピー）
4. `ai-worker.js` と `coi-serviceworker.js` をリポジトリから削除
5. GitHub Pages にデプロイ

---

## 既存 main.js から流用するコードブロック（コピーそのまま使う）

以下は **変更不要** でそのままコピーする：

- `openDB()` 〜 `dbClear()` の全DB関数
- `countPages()`
- `parseTitleMeta(title)`
- `importScrapboxJSON(json, onProgress)`
- `handleJSONFile(file, mode)`
- `setImportProgress()` / `hideImportProgress()` / `setImportStatus()`
- `setUpdateProgress()` / `hideUpdateProgress()` / `setUpdateStatus()`
- `makeScrapboxUrl(title)`
- `appendMessage(role, text, sources)`
- `makeHaloSVG()`
- `setStatus(state, text)`
- `showToast(msg)`
- `escHtml(str)`
- データ更新モーダル関連のイベントリスナー
- DOM要素の参照定義群

---

## 期待される動作フロー

```
1. ページ読み込み
   → WebGPU対応チェック
   → IndexedDB確認
   → データあり → チャット画面へ
   → データなし → インポート画面へ

2. インポート
   → Scrapbox JSON をドロップ
   → parseTitleMeta で全ページをパース・DB保存
   → （Embeddingは不要）
   → チャット画面へ

3. チャット
   → ユーザー入力
   → expandQuery で同義語展開
   → searchKeyword で上位10件取得
   → buildContextBlock でプロンプト構築
   → WebLLM engine.chat.completions.create (stream: true)
   → ストリーミング表示
   → 参照資料をバブル下部に表示（Scrapboxリンク付き）

4. 停止
   → 停止ボタン → generationAbortController.abort()
   → ストリームのforループをbreakして生成停止

5. モデル切り替え
   → セレクタ変更 → engine.reload(newModelId)
```

---

## 品質チェックリスト

実装後に以下を確認すること：

- [ ] Chrome で `navigator.gpu` が存在することを確認
- [ ] 初回モデルロード時にダウンロード進捗が表示される
- [ ] 2回目以降はキャッシュから即座にロードされる
- [ ] 質問に対して関連資料が `参照資料` セクションに表示される
- [ ] 生成中に停止ボタンが表示され、クリックで停止できる
- [ ] 繰り返しや文字化けが発生しない
- [ ] データ更新ボタンで再インポートできる
- [ ] コンソールに `[Ankel]` プレフィックスでログが出る
- [ ] `coi-serviceworker.js` を削除してもエラーが出ない
