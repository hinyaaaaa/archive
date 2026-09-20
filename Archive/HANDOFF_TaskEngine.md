# TaskEngine — ファイル構成(アーキテクチャ刷新版)

## ディレクトリ構成

```
index.html              (16KB)  骨組みのみ。CSS/JSは外部参照。
css/
  app.css               (44KB)  全スタイル
js/
  app.js                (76KB)  TaskEngine本体ロジック(データ管理・ルーティング・タスクCRUD)
  solar-system.js        (28KB) Three.js恒星系モジュール(type=module)
  textures-data.json    (892KB) 惑星テクスチャ(base64、遅延fetch対象)
```

**この4ファイル+READMEをまとめて、同じディレクトリ構造のままWebサーバーへ配置してください。**
相対パス参照(`css/app.css`、`js/app.js`等)を使っているため、ディレクトリ構造を崩すと動作しません。

## なぜ分割したか(初回起動速度)

以前は全部が1つの `index.html`(1MB超)で、ブラウザは最初の1バイトを描画する前に
テクスチャ(910KB)を含む全データをダウンロード・パースし終える必要がありました。

分割後は:

1. **初回に必要なのは index.html(16KB) + css/app.css(44KB) + js/app.js(76KB) のみ**
   → タブバー・タスク一覧はこの3ファイルだけで表示できる
2. **js/solar-system.js と js/textures-data.json は「今日」タブを開いた瞬間だけ取得**
   → 一度も「今日」タブを見ないユーザーには一切ダウンロードされない
3. **ブラウザの標準HTTPキャッシュがファイル単位で効く**
   → タスク管理ロジック(app.js)だけを直しても、テクスチャ(892KB)の
     キャッシュは無効化されない(以前は1ファイルだったため、1行直すだけで
     ユーザー全員が910KBを再ダウンロードする状態だった)

## 追加の高速化

- Three.js を非圧縮版(1.27MB)からminify版(670KB)へ切り替え
- Google Fontsのリクエストを実際に使っているウェイトだけに絞り込み
  (12ウェイト→6ウェイト、`Shippori Mincho`無印ファミリーは完全に不要だったため削除)
- `<link rel="preload">` で js/app.js・css/app.css の取得開始を早期化
- `<link rel="preconnect">` でCDN(jsDelivr)・Google Fontsへの接続を先行確立

## 既知の制約

- `js/solar-system.js` 内の `fetch('./textures-data.json')` は `file://` で直接
  開くとCORSでブロックされます。**必ずHTTPサーバー経由(GitHub Pages等)で
  配信してください**(ヒアリング済み、現状の運用と一致)。
- Three.js本体はCDN(jsDelivr)からの取得のため、初回はオフラインで
  「今日」タブが表示できません(タブバー・タスク一覧はオフラインでも動作します)。
