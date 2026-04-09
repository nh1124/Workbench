# Native Desktop — ウィンドウ管理

## ウィンドウの種類

| 種類 | ラベルプレフィックス | サイズ | 用途 |
|---|---|---|---|
| メインウィンドウ | `main-` | 1280×860 | 通常の作業画面 |
| クイックノートウィンドウ | `quick-note-` | 560×760 | 常に最前面に表示されるメモ入力 |

クイックノートウィンドウは `always_on_top = true` で開かれます。

## ウィンドウラベルの生成規則

Tauri はウィンドウを文字列ラベルで識別します。
複数のウィンドウを同時に開けるよう、ラベルは以下の形式で一意に生成しています。

```
main-{Unix時刻ミリ秒}-{単調増加カウンタ}
quick-note-{Unix時刻ミリ秒}-{単調増加カウンタ}
```

例: `main-1712500000000-1`, `quick-note-1712500000000-1`

カウンタは `AtomicU64` で管理しており、タイムスタンプと組み合わせることで
同一ミリ秒内に複数ウィンドウを開いても衝突しません。

**実装箇所:** `window.rs` — `build_main_window_label()` / `build_quick_note_window_label()`

## なぜ tauri.conf.json のウィンドウを setup で閉じるのか

`tauri.conf.json` に記述したウィンドウは `WebviewWindowBuilder` を経由せずに生成されるため、
`disable_drag_drop_handler()` を設定できません。

`disable_drag_drop_handler()` を省略すると、WebView 内の JavaScript がファイルドラッグ＆ドロップ
イベントを受け取れなくなります（OS がイベントを横取りする）。

そのため setup フック内で:
1. conf.json 由来のウィンドウをすべて閉じる
2. Rust API 経由で `disable_drag_drop_handler()` 付きのウィンドウを再生成する

という手順を踏んでいます。

**将来的な対応:** Tauri が JSON 設定で `disable_drag_drop_handler` をサポートした場合は、
setup 内の「閉じて再生成」ロジックを削除し、conf.json のみで管理できます。

## 複数インスタンスの仕組み

`tauri-plugin-single-instance` により、アプリは常に **1 プロセス** だけ動作します。
2つ目のプロセスが起動されると、そのプロセスはすぐに終了し、
代わりに **既存プロセス内のハンドラが呼ばれます**。

```
新プロセス起動
  ↓
tauri-plugin-single-instance が検出
  ↓
新プロセスを終了
  ↓
既存プロセスのハンドラ (lib.rs) を呼び出す
  ↓
should_open_new_main_window(argv) を確認
  ├─ true  → open_new_main_window()  (新しいメインウィンドウを生成)
  └─ false → 何もしない（クイックノート起動の場合など）
```

`should_open_new_main_window()` は、argv に `quick-note-window=1` が含まれていない場合に
`true` を返します（`window.rs` を参照）。

## タスクバーの shift+click で新しいインスタンスを開く

Windows のタスクバーアイコンを **shift+click** すると、OS がアプリの新プロセスを起動します。
`tauri-plugin-single-instance` がこれを捕捉し、上記の「複数インスタンスの仕組み」により
新しいメインウィンドウが開かれます。

**追加実装は不要です。** single-instance プラグインのハンドラが自動的に処理します。

## クイックノートウィンドウの判定

クイックノートウィンドウが必要な場面では、プロセス起動時の argv に
`quick-note-window=1` を渡すことで通常ウィンドウと区別しています。

具体的には WebView の URL に `?quick-note-window=1` を付与して開きます
（`window.rs` の `open_new_quick_note_window()` を参照）。

フロントエンド側では `window.location.search` でこのパラメータを読み取り、
クイックノート UI を表示するかどうかを判断します。

## メインウィンドウを閉じた時の挙動（常駐）

メインウィンドウ（`main-`）は `CloseRequested` をフックしており、
以下のルールで閉じ方を切り替えます。

- **開いている main が 1 枚だけ**: `close` をキャンセルして `hide`（常駐）
- **開いている main が 2 枚以上**: そのまま `close`

これにより、常駐用のメインウィンドウは最大 1 枚に保たれ、
「閉じるたびに hidden ウィンドウが増える」状態を防いでいます。

クイックノートウィンドウ（`quick-note-`）は常に `close` され、`hide` はしません。

## トレーアイコンの挙動

常駐中はタスクトレーに Workbench アイコンを表示します。

- **左クリック**: メインウィンドウを再表示（hidden の `main-*` を復帰。無ければ新規作成）
- **右クリック**: コンテキストメニューを表示
- 右クリックメニュー:
  - `Open Workbench` … メインウィンドウを再表示
  - `Quit` … アプリを終了

## 注意事項

- ウィンドウを閉じる処理は `close_quick_note_window` コマンド経由で呼ぶ設計です。
  メインウィンドウは close 操作時に上記ルールで `hide` / `close` を自動判定します。
- `unminimize()` → `show()` → `set_focus()` の順序は意図的です。
  最小化状態のまま `set_focus()` を呼んでも画面に表示されないためです。
