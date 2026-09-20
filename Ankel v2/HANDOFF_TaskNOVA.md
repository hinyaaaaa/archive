# TaskNOVA 今回セッションの変更点まとめ

## 1. バグ修正

### 1-1. 惑星タップの二重発火（`js/solar-system.js`）
iOS Safariは`touchend`の直後に合成`mouseup`イベントを発火することがあり、
`onPointerUp`が`touchend`と`window`の`mouseup`の両方から呼ばれて二重実行
されていた（タップした瞬間に天体が完了扱いになる不具合の原因）。
`lastTouchEventTime` + 800msガードで合成イベントを無視するよう修正。

### 1-2. `.page-wrap`下パディングの固定値148px（`css/app.css`）
他の要素（`#tabbar`, `#fab-add`, `#solar-stage`）は全て
`max(24px, var(--safe-bottom))`で統一されていたが、`.page-wrap`だけ
`148px`固定だった。Face ID機種でsafe-bottomが増えるほど実質的な余白が
目減りし、機種によって間隔が不揃いになる原因だった。
`calc(var(--tabbar-h) + max(24px, var(--safe-bottom)) + 88px)`に統一。

### 1-3. WebGLキャンバスの再構築漏れ（新規発見・修正）
`solar-system.js` / `task-field.js`とも、`init()`は`if (!scene)`だけを
条件にシーン構築をスキップしていた。しかし`navigateTo()`は「同じページに
既にいる状態」でも呼ばれるケースが複数ある
（`setTodayOverride`, `skipWeeklyToday`, `doRecompute`,
タスク編集後の`saveTask`など）。この場合`main-content.innerHTML`が
丸ごと差し替わり`<canvas>`要素がDOMから消えるが、`renderer`は古い
canvas を握ったままになり、新しいcanvasには何も描画されなくなる。
→ `renderer.domElement !== canvasEl`を検知したら再構築するよう修正。

### 1-4. windowイベントリスナーの累積（新規発見・修正）
上記と同じ理由で`attachInteraction()`が複数回呼ばれると、`window`への
`mousemove`/`mouseup`リスナーが呼ぶたびに増え続けていた。
一度だけ登録するようガードを追加、`dispose()`で確実に解除。

## 2. Settings（設定）タブのHUD再設計
罫線グリッド式の「テレメトリー・コンソール」風に全面刷新。
- `.tel-grid` / `.tel-cell`：ステータスパネル（未完了・期限超過・週次件数）
- `.tel-param` / `.tel-slider-track`：目盛り付きキャパシティスライダー
- `.panel` / `.panel-title`：英字+日本語併記の見出し

## 3. タスクタブ = 宇宙空間フィールド化（最大の変更）
「タスク」タブを罫線リストから、軌道を持たない無造作配置の浮遊惑星
フィールドに全面置き換え。

- **新規ファイル `js/task-field.js`**：Three.jsモジュール。
  タスクIDのハッシュから決定的な球面座標＋緩やかなドリフトで天体を配置。
  「今日」の恒星系（軌道・公転あり）とは対照的に、秩序を持たない散らばり方。
  - 週次タスクは環（リング）付きの天体として区別
  - 締切が近いほど原点に近い距離に配置（対数スケール）
  - 負荷が高いほど天体が大きい
  - `window.SolarSystem`とテクスチャキャッシュを共有（892KB JSONの二重取得を回避）

- **HUD Callout（達成・編集UI）**：天体をタップすると、天体の投影座標
  からリーダーライン（SVG）が上方へ伸び、その先端にHUDカードが出現。
  カード内の「達成」ボタンで完了、「編集」ボタンで既存の編集モーダルを開く。
  カードのアクセントカラーは天体の負荷値カラーに連動。

- **`js/app.js`の変更**：
  - `getPoolTasks()`新設：キャパシティによる絞り込みを行わず、
    未完了の全タスク（単発＋今日まだ完了していない週次）を返す
  - `completePoolTask()`新設：達成時の共通処理
  - `renderTasksPage()`を全面書き換え（罫線リスト→フィールドHTML）
  - `renderTaskItem()` / `emptyState()` / `dueDisplay()` / `setTaskFilter()` /
    `toggleTaskDoneFromList()` / `toggleWeeklyDoneFromList()`は削除（フィールド化に伴い不要）
  - `navigateTo()`：home⇔tasks間で確実にWebGLコンテキストを破棄するよう変更
  - `wireTaskFieldCallbacks()`新設（`wireSolarSystemCallbacks`と対）

- **編集モーダルに削除ボタンを追加**（`index.html`）：
  HUD Calloutからは「達成」「編集」のみで、削除は編集モーダルを開いた後
  に行う導線にした（誤操作防止）。

- **死んだCSSの削除**：`.mlog-*`, `.sub-tab*`, `.tab-count`, `.empty-state`,
  `.empty-icon`, `.skip-btn`, `.icon-btn`, `.flow-ring*`, `.achievement-banner`,
  `.day-controls`, `.day-pill`, `.recompute-btn`, `.summary-grid`,
  `.capacity-row`等、旧デザインで使われていたが今回のリファクタで
  参照されなくなったクラスを一括整理。

## 既知の制約・未検証事項
- このセッションはネットワーク制限によりThree.js CDN
  （cdn.jsdelivr.net）にアクセスできず、**実際のブラウザ描画確認ができて
  いません**。構文チェック・DOM構造チェック・関数参照の整合性チェックは
  Node.js上で可能な範囲で実施済みですが、実機（特にiOS Safari）での
  最終確認を強く推奨します。
- `js/task-field.js`のカメラ距離・ドリフト振幅などの数値パラメータは
  初回実装値です。実際の見た目を見てから微調整が必要になる可能性が
  高いです。
- 週次タスクの「今日まだ完了していないものだけフィールドに出す」という
  仕様上、日付が変わるとフィールドの見た目（天体数）が変わります。
  意図した挙動ですが、体感として確認をお願いします。
