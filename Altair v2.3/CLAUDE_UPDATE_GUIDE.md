# Altair アップデートガイド v3.2

---

## ⚠️ Claudeへの義務事項

**このガイドは修正のたびに必ず更新すること。**

修正を行ったら、以下を必ず更新する：
- バージョン番号（ガイド冒頭・バージョン履歴・`config.js` の `APP_VERSION`）
- 変更したファイルの「ファイル構成」欄の説明
- 「バージョン履歴」に今回の変更内容を追記
- 新しい関数・データ構造を追加した場合はその節も更新

ガイドを更新せずに修正ファイルだけ出力することは禁止。

---

## このガイドの目的

このアプリは **コードが分からなくても Claude に修正を頼める** ように作られています。
修正したいとき、**このファイルと修正対象のファイル** を Claude に渡せばOKです。

---

## アプリの概要

**Altair**（アルタイル）— タスク自動割り当てアプリ

### できること

- タスクを登録しておくと、**今日やるべきタスクを自動で選んで表示**する
- タスクには「負荷値（0.5〜5、0.5刻み）」を設定する（5が一番重い）
- 負荷値4以上の重いタスクは **1日1つまで** 自動割り当て（期限切れ・本日期限・週次は除く）
- **平日・休日それぞれのキャパシティ**を超えないよう自動で組み合わせる
- タスクをこなすと残り負荷が減る（キャパ − 完了済み負荷を表示）
- **完了済み負荷がキャパシティ以上** になると「目標達成」表示になりタスク非表示
- 割り当てたタスクをすべてこなしてもキャパ未達の場合は「全完了」として区別表示
- **毎週繰り返すタスク**も設定できる（月・水・金など曜日指定）
- **期限が近いタスクを優先**して自動割り当て
- 完了済み once タスクは **翌日起動時に自動削除**
- キャパシティ変更時は **完了済みを保持したまま未完了タスクだけ組み直す**
- 壁紙を設定できる

### 画面の説明

| タブ | 説明 |
|------|------|
| 今日 | 今日のタスク一覧・残り負荷表示 |
| タスク | 全タスクの管理（追加・編集・削除・完了） |
| 設定 | キャパシティ・祝日登録・壁紙・データ管理 |

---

## GitHub Pages へのアップロード方法

### アップロードするファイル（全9ファイル）

```
index.html            ← メインHTML（JSを相対パスで参照）
style.css             ← 全スタイル
config.js             ← 定数定義
store.js              ← 状態管理・割り当てエンジン
app-common.js         ← 共通UI部品
app-core.js           ← 初期化・ナビゲーション・今日ページ
app-tasks.js          ← タスク管理
app-settings.js       ← 設定ページ
CLAUDE_UPDATE_GUIDE.md ← このファイル
```

全ファイルをリポジトリの **ルート（トップレベル）** に置いてください。
サブフォルダに入れると相対パスが壊れます。

### プレビュー・動作確認用

`Altair_vXX.html`（統合版）をブラウザで直接開けば動作確認できます。
GitHub Pages にはアップロード不要です。

---

## Claude に修正を頼む方法

### 渡すファイル

```
CLAUDE_UPDATE_GUIDE.md（このファイル・必須）
修正対象のファイル（例: store.js, app-tasks.js）
```

一箇所の修正なら関係するファイルだけでOK。
全体的な修正や大きな機能追加なら全ファイルを渡す。

### 依頼テンプレート（コピーして使う）

```
以下のファイルを参照してください：
- CLAUDE_UPDATE_GUIDE.md
- （修正対象のファイル）

【依頼内容】
（ここに修正・追加したい内容を書く）
```

### 依頼例

```
「タスクの完了を取り消せるようにしてほしい」
「タスクにメモ欄を追加してほしい」
「期限超過タスクに通知を出してほしい」
「ダークモード・ライトモードの切り替えを追加してほしい」
```

---

## ファイル構成と依存関係

**この読み込み順を変えると動かなくなるので注意。**

```
index.html
  ├─ style.css        ← デザイン全般（依存なし）
  ├─ config.js        ← 定数（CFGオブジェクト）（依存なし）
  ├─ store.js         ← 状態管理・割り当てエンジン  ← config.js に依存
  ├─ app-common.js    ← 共通UI                     ← config.js, store.js に依存
  ├─ app-core.js      ← 初期化・今日ページ          ← 上記すべてに依存
  ├─ app-tasks.js     ← タスク管理                 ← 上記すべてに依存
  └─ app-settings.js  ← 設定ページ・init()呼び出し ← 上記すべてに依存
```

### 各ファイルの責務

| ファイル | 主な責務 |
|----------|---------|
| `config.js` | `CFG` オブジェクト。定数・色・曜日名・デフォルト値。`STORAGE_KEY`（現行キー）と `LEGACY_KEYS`（旧キー一覧）を管理 |
| `store.js` | `S` オブジェクト（グローバル状態）。localStorage 読み書き・スナップショット生成・リセット。`_fillEntries()` 内の `internalUsed` で週次タスクの負荷をキャパ計算に反映。`S.extraDoneToday`（`{date, taskIds[], load}`）でスナップ外達成タスクを当日管理。`simulateEarliestCompletion()` で最速完了日を返す。`isWeeklySkippedOn()` / `skipWeeklyToday()` / `unskipWeeklyToday()` でスキップ管理。`isHoliday()` は `settings.todayOverride` を優先参照。期限切れ・本日期限タスクはスナップ内負荷を半減。`unlockDate` が今日より後のタスクは候補から除外。`rebalanceWithKeep()` で完了済み負荷を保持したまま再充填 |
| `app-common.js` | `showToast` / `openModal` / `closeModal` / `loadBadge` / `deadlineChip` / `applyBackground` |
| `app-core.js` | `navigateTo` / `renderHome` / `init` / `doRecompute`。今日ヘッダーに平日/休日トグルボタン・右上に再計算ボタン（完了済み保持）。週次タスクにスキップボタン。期限半減バッジ表示 |
| `app-tasks.js` | `renderTasksPage` / `openAddTask` / `openEditTask` / `saveTask` / `executeDeleteTask` / `markExtraDoneFromList` / `undoExtraDoneFromList`。タスクページ右上に最速完了日シミュレーション。スナップ外未完了タスクに「今日達成に追加」ボタン。`unlockDate` フィールド対応・タスク一覧で解禁日バッジ表示 |
| `app-settings.js` | `renderSettings` / キャパシティ保存 / 壁紙 / `init()` 呼び出し。祝日管理UI廃止（平日/休日切り替えは今日タブのトグルボタンへ移動） |

---

## データ構造

データは端末の `localStorage` に保存されます（サーバー不要）。

```javascript
S = {
  tasks: [
    {
      id:          'abc123',        // 自動生成ID
      title:       'レポート提出',  // タスク名（XSSエスケープ済み）
      load:        2.5,              // 負荷値 0.5〜10（0.5刻み）
      type:        'once',          // 'once'=一回のみ / 'weekly'=毎週
      deadline:    '2025-06-01',    // 期限 (once のみ、なければ null)
      done:        false,           // 完了フラグ (once のみ)
      doneDate:    '2025-06-01',    // 完了日 (once のみ、翌日削除判定に使用)
      unlockDate:  '2025-06-01',    // 解禁日 (once のみ、省略可) — この日以降にスナップ候補に入る
      weekDays:    [1, 3],          // 曜日 0=日〜6=土 (weekly のみ)
      doneHistory: ['2025-06-02'],  // 完了日付の履歴 (weekly のみ)
      skipHistory: ['2025-06-03'],  // スキップした日付の履歴 (weekly のみ)
      createdAt:   1717200000000,   // 登録日時 (Unix ms)
    }
  ],

  todayPlan: {                      // 今日の割り当てスナップショット
    date: '2025-06-02',
    entries: [
      { id: 'abc123', load: 3, src: 'buffer', type: 'once' }
      // src: 'weekly' | 'overdue' | 'today_dl' | 'urgent' | 'deadline' | 'buffer'
    ]
  },

  extraDoneToday: {                 // スナップ外「今日達成」タスク（当日のみ有効）
    date: '2025-06-02',            // 日付が変わったら自動リセット
    taskIds: ['xyz789'],           // 達成したタスクのIDリスト
    load: 2.5,                     // 達成した負荷の合計
  },

  settings: {
    capacityWeekday: 10,  // 平日の負荷上限（2〜30）
    capacityHoliday: 6,   // 休日・祝日の負荷上限（0〜30）
    holidays: [],         // 旧来の祝日リスト（後方互換のため残存、UIは廃止）
    bg:        '',        // 壁紙の画像データ（base64）
    bgOpacity: 65,        // 壁紙オーバーレイの暗さ（0〜95）
    todayOverride: null,  // { date: 'YYYY-MM-DD', isHoliday: bool } — 今日の平日/休日手動切り替え（当日のみ有効）
  }
}
```

---

## 割り当てエンジンの仕様（store.js）

### スナップショットとは

毎日初回起動時に「今日やるタスクの確定リスト」を1回だけ生成します（= スナップショット）。
タスクを完了・未完了に変えても補充はされません。

### 生成関数

| 関数 | 呼び出しタイミング | 動作 |
|------|------------------|------|
| `_generateSnapshot()` | 当日初回・タスク追加・削除・キャパ変更後 | 完全リセットして全タスクを再評価 |

### 割り当て優先順位

1. 週次タスク（その曜日に設定されたもの）← **キャパを超えても必ず表示**
2. 期限切れタスク ← **キャパを超えても強制表示**
3. 本日期限タスク ← **キャパを超えても強制表示**
4. 明日期限タスク ← **キャパを超えても強制表示**
5. 期限あり（明後日のみ）← 残りキャパに収まるものだけ
6. 期限なし＋期限3日以上先 ← 残りキャパを重い順で貪欲充填

### 翌日自動削除

`loadState()` 起動時に `_purgeDoneTasks()` が走り、
`done === true` かつ `doneDate` が今日より前の once タスクを削除します。


---

## モーダル一覧

| モーダルID | 用途 | 呼び出し関数 | 実行関数 |
|-----------|------|------------|---------|
| `modal-task` | タスク追加・編集 | `openAddTask()` / `openEditTask(id)` | `saveTask()` |
| `modal-delete-confirm` | タスク削除確認 | `openDeleteConfirm(id)` | `executeDeleteTask()` |
| `modal-confirm` | 全データリセット確認 | `openResetConfirm()` | `executeReset()` |

---

## Claude への注意事項（修正時に必ず守ること）

1. **このガイドを必ず更新する**（バージョン番号・変更内容・関数名）
2. **修正後は元のファイル名で出力する**（分割構成を維持）
3. **統合版 `Altair_vXX.html` も必ず出力する**（プレビュー用）
4. **JavaScriptの構文エラーがないか確認する**
5. **データ構造を壊さない**
   - `S.tasks` の配列構造を変えると過去データが読めなくなる
   - フィールド追加時は `Object.assign({}, デフォルト値, 保存済みデータ)` で後方互換を保つ
6. **`init()` は `app-settings.js` の末尾で1回だけ呼ぶ**
7. **`window.confirm()` / `window.alert()` を使わない**（iOS PWAで動作しない）
   - 削除確認 → `openDeleteConfirm(id)` → `modal-delete-confirm` → `executeDeleteTask()`
   - リセット確認 → `openResetConfirm()` → `modal-confirm` → `executeReset()`
8. **モーダルの開閉は `openModal('id')` / `closeModal('id')` で統一**
9. **キャパシティ変更時は `resetTodayPlan()` を呼ぶ**（`rebalanceSnapshot()` は `rebalanceWithKeep()` へのエイリアス）
10. **タスク追加・削除時は `resetTodayPlan()` を呼ぶ**

---

## バージョン履歴

| バージョン | 主な変更 |
|-----------|---------|
| v3.0 | キャパ達成時でも期限超過・本日期限・明日期限タスクが残っていれば今日タブに表示（達成バナー＋緊急タスク一覧）/ タスクプールのチェックが今日の負荷バーに反映される（スナップ外 → `extraDoneToday` 加算、スナップ内 → `done` フラグのみ）/ 今日タブはスナップの未完了タスクのみ表示に統一（extraDoneTasks 表示を廃止）/ `toggleTaskDoneFromList` でスナップ内外を正しく判定して負荷計算に反映 |
| v2.9 | タスク一覧のチェックで常に今日の負荷計算に反映（スナップ内外を問わず `toggleTaskDoneFromList` が extraDone を自動連動）/ 専用ボタンを廃止しチェックボックス操作に一本化 / エクスポートファイル名を `Altair_save_data.json` に固定（上書き保存対応） |
| v2.8 | スナップ外タスクを「今日達成に追加」できる機能を追加（`markExtraDone` / `unmarkExtraDone`）/ その負荷を今日の消費に加算してスナップを自動組み直し / 取り消しも可能 / タスクページ右上に最速完了日シミュレーション（`simulateEarliestCompletion()`）を常時表示 / `S.extraDoneToday`（`{date, taskIds, load}`）を新規フィールドとして追加（日付変わりで自動リセット） |
| v2.7 | 負荷値の最大を5に変更（0.5〜5、0.5刻み）/ キャパシティスライダーを整数単位に戻す / 負荷4以上のタスクは1日1つまでの制約を割り当てエンジンに追加（`heavyCount` カウンタ）/ 期限切れ・本日期限・週次タスクは制約対象外 |
| v2.5 | `STORAGE_KEY` をバージョン非依存の `altair_data` に変更 / 旧キー（`altair_v2` 等）からの自動マイグレーション追加 / 以降のアップデートでキーが変わってもデータが引き継がれる仕組みを導入 |
| v2.4 | 週次タスクの負荷値をキャパシティ計算に正しく反映するバグ修正 / `_fillEntries()` 内で週次・強制タスクの負荷も `remaining` に積算するよう変更（`internalUsed` カウンタ導入） |
| v2.3 | 再生成ボタンを「完了保持・未完了のみ組み直し」に変更しリスト下部に移動 / キャパ変更時も完了保持リバランスに統一 / データリセットのバグ修正 / `rebalanceSnapshot()` と `resetTodayPlan()` に分離 / アップデートガイド義務化 |
| v2.2 | 平日・休日キャパシティ分離 / 祝日登録機能 / 残りキャパ表示 / 全完了とキャパ達成を区別 / 完了済みonceタスクの翌日自動削除 / `doneDate` フィールド追加 |
| v2.1 | ファイル分割構成・GitHub Pages対応 / iOS PWA UIバグ修正（safe-area対応）/ タスク削除のwindow.confirm廃止 / 割り当てロジックコメント整備 |
| v2.0 | タスク自動割り当て・週次タスク・壁紙・リセット修正・スクロールバグ修正 |
| v1.8 | タイマー・暗記カード・スキルツリー・テスト成績・実績バッジ搭載（削除済み） |
