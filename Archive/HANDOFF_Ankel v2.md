## 1. Ankel の概要

Ankel は、Scrapbox 由来のデータを対象としたローカル検索エンジンです。

現行実装は `server.js` を中心とした構成ですが、検索精度向上のための機能はかなり実装されています。

主な目的は次の3点です。

- 曖昧なクエリでも目的のページへ到達できる検索
    
- タグだけではなく本文内容を重視した検索
    
- Scrapbox データ全体を横断して探せる検索
    

---

## 2. 現在の構成

```text
Ankel/
├── client/
│   └── index.html
├── data/
│   ├── pages.json
│   ├── chunks.json
│   ├── vectors.json
│   ├── qa_index.json
│   ├── qa_vectors.json
│   └── chunk_vectors.json
├── server/
│   ├── server.js
│   ├── debug_vec.js
│   ├── new_search.js
│   └── splice.js
└── 起動.bat
```

役割は以下の通りです。

- `server/`: 検索 API、検索スコアリング、データ処理
    
- `client/`: UI / 画面表示
    
- `data/`: 取り込み済みデータと検索用インデックス
    
- `起動.bat`: 起動補助
    

---

## 3. 起動

基本的には Node.js から `server.js` を起動します。

```powershell
Start-Process "ollama" -ArgumentList "serve"
Set-Location 'Ankel/server'
node --max-old-space-size=4096 server.js
```

- 既定ポートは `3000`
    
- メモリ使用量を考慮し、`--max-old-space-size=4096` を付けて起動する運用
    
- Ollama が起動している場合、ベクトル関連機能を利用可能
    

---

## 4. データ配置

既定のデータ保存先は `Ankel/data` です。

環境変数 `ANKEL_DATA_DIR` を設定すると保存先を変更できます。

基礎データ:

- `pages.json`
    
- `chunks.json`
    

補助インデックス:

- `vectors.json`
    
- `qa_index.json`
    
- `qa_vectors.json`
    
- `chunk_vectors.json`
    

データパスは固定値に依存させないことが重要です。

---

## 5. API

|エンドポイント|メソッド|内容|
|---|---|---|
|`/api/search`|POST|`{"query":"検索文字列"}` で検索|
|`/api/page`|GET|`?title=ページタイトル` で本文取得|
|`/api/import`|POST|Scrapbox JSON を取り込み|
|`/api/related`|GET|関連ページを取得|

---

## 6. 現在の検索パイプライン

検索処理は概ね次の順で動作します。

1. `parseQuery()`
    
    - 検索語の正規化
        
    - 年度展開
        
    - 同義語展開
        
    - アイコン ID 展開
        
2. `buildBM25()`
    
    - 全文 BM25 インデックス生成
        
3. `buildCooccurrence()`
    
    - 共起語の生成
        
4. `search()`
    
    - 各検索指標を統合して最終スコアを算出
        
5. ベクトル補助
    
    - `vectorReady`
        
    - `chunkVectorReady`
        
    - `qaReady`
        
    
    が利用可能な場合、それぞれのベクトル情報を追加スコアとして使用
    

---

## 7. 現在有効な検索要素

|要素|状況|
|---|---|
|BM25|稼働中|
|2-gram / 3-gram|稼働中|
|`allSegments` 2倍付与|稼働中|
|PageRank|稼働中|
|年度重み|稼働中|
|意図分類|稼働中|
|近接性スコア|稼働中|
|本文先頭密度|稼働中|
|共起語拡張|稼働中|
|ベクトル検索|Ollama があれば補助的に使用|
|QA ベクトル|稼働中|
|チャンクベクトル|稼働中|

現行の概念的な最終スコアは次のような構造です。

```javascript
final =
  (min(bm25, 40) * 15 * lenPenalty
   + pr * 30
   + prox
   + vecScore
   + frontBonus)
  * tagMult
  * intentBonus
  * yWeight
```

---

## 8. 現在残っている制約

### `kuromoji`

`kuromoji` は初期化済みで、辞書も利用可能な状態ですが、検索クエリの token 化の本線にはまだ十分組み込まれていません。

### チャンク分割

現状の `splitChunks()` は実質的に「1ページ = 1チャンク」の構成です。

長文ページについては、検索単位をさらに細かく分割する余地があります。

### `server.js` の責務集中

`server.js` に以下の役割が集中しています。

- 検索
    
- データ読み込み
    
- 永続化
    
- API
    
- 初期化
    
- ベクトル処理
    

今後の保守性を考えると、責務分離が必要です。

---

## 9. 重要ファイル

### サーバー

- `Ankel/server/server.js`
    
- `Ankel/server/package.json`
    

### クライアント

- `Ankel/client/index.html`
    

### データ

- `Ankel/data/pages.json`
    
- `Ankel/data/chunks.json`
    
- `Ankel/data/vectors.json`
    
- `Ankel/data/qa_index.json`
    
- `Ankel/data/qa_vectors.json`
    
- `Ankel/data/chunk_vectors.json`
    

### 補助スクリプト

- `debug_vec.js`
    
- `new_search.js`
    
- `splice.js`
    

これらは基本的に一回限りの検証・補助用途として扱い、恒常的な処理と混同しないこと。

---

## 10. データ構造と取り込み

### タイトル規則

```text
{年度}-{タグ}-{サブタグ}-{説明}
```

例:

```text
2026-対面式-HR委員会へ要請、誘導詳細
```

### ページ種別

- `definition`
    
- `handover`
    
- `summary`
    
- `schedule`
    
- `plan`
    
- `memo`
    
- `roster`
    
- `opinion`
    
- `general`
    

### 検索品質に直結する処理

以下は安易に変更しないこと。

- `cleanBody()`
    
- `extractLinks()`
    
- `loadData()`
    

特に `loadData()` は `pages` と `chunks` の整合性を維持しながら、`pageType` や `views` の補正も行うため注意が必要です。

---

## 11. ベクトル関連の注意

以下のフラグやデータ構造を雑に変更すると検索結果が崩れる可能性があります。

- `vectorReady`
    
- `chunkVectorReady`
    
- `qaReady`
    
- `qaVectors`
    
- `chunkVectors`
    

特にベクトルデータの保存先を変更する場合は、生成側と読み込み側を同時に修正する必要があります。

また、ベクトルが利用できない場合でも BM25 ベースの検索が成立する構成を維持することが重要です。

---

## 12. 今後の改善候補

優先候補は以下の通りです。

### 1. `server.js` の責務分離

検索・永続化・API・初期化などを分割し、保守性を向上させる。

### 2. `kuromoji` の本格導入

日本語クエリを token 単位で扱い、検索語の正規化や語単位のマッチ精度を高める。

### 3. 長文ページのチャンク分割

1ページ1チャンク方式をやめ、長文ページを複数の検索単位へ分割する。

### 4. 評価クエリセットの構築

検索結果を目視だけでなく数値で比較できるようにする。

代表クエリ:

```text
対面式の誘導どうするの
しらかし懇談会とは何か
生徒総会の司会原稿
```

改善のたびにこれらを確認し、検索結果の差分を記録する。

### 5. 個別意見系ページの重み調整

検索結果の取りこぼしが残る場合、`opinion` 系ページなどの重みを再調整する。

---

## 13. 変更時の注意

- データパスを固定しない
    
- `cleanBody()` と `extractLinks()` の出力形式を不用意に変更しない
    
- `pages` と `chunks` の整合性を崩さない
    
- `vectorReady` / `chunkVectorReady` / `qaReady` の判定を雑に変更しない
    
- `qaVectors` / `chunkVectors` の保存先を変更する場合は読み込み側も変更する
    
- 補助スクリプトを本線処理へ不用意に組み込まない
    

---

## 14. 開発時の運用ルール

変更時は次の手順を基本とします。

1. 大きな変更の前にバックアップを取る
    
2. PowerShell のヒアドキュメントを利用して変更する
    
3. 変更後に対象ファイルを読み直す
    
4. 古い前提や不要なコードが残っていないか確認する
    
5. 代表クエリで検索結果を確認する
    

特に検索エンジンでは、局所的な修正が検索ランキング全体へ波及するため、変更後の回帰確認を必須とします。

---

## 15. 次の開発セッションで最初に確認すること

最初に以下の2文書を確認します。

```text
Ankel/HANDOFF_Ankel v2
Ankel/Ankel検索改善_実装方針書.dm
```

そのうえで、現行コードとのズレを確認します。

次に、

- `kuromoji` を先に実検索へ組み込むか
    
- チャンク分割を先に行うか
    
- `server.js` の責務分離を先に行うか
    

を判断します。

判断時には代表クエリの検索品質を基準にします。

---

## 16. 引き継ぎ時の重要事項

Ankel は単純な文字列検索ではなく、複数のランキング要素を組み合わせた検索エンジンになっています。

特に、

```text
BM25
+ PageRank
+ 年度重み
+ 意図分類
+ 近接性
+ 本文先頭密度
+ 共起語
+ ベクトル
+ QA / チャンク補助
```

という多段構成になっているため、1つの要素だけを改善して全体性能を判断しないこと。

検索結果の改善では、代表クエリを用いた回帰確認を行い、検索精度を定量的・継続的に追跡することを推奨します。