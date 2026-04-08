# Native Desktop — グローバルキーボードショートカット

## 登録済みショートカット一覧

| ショートカット | アクション | 対象 OS |
|---|---|---|
| **Ctrl+Shift+N** | 新しいメインウィンドウを開く | 全プラットフォーム |
| **Win+Alt+N** | クイックノートウィンドウを開く | Windows（Win キー） |
| **Ctrl+Alt+N** | クイックノートウィンドウを開く | Windows / macOS / Linux |

すべて **グローバルショートカット**（アプリがバックグラウンドにいても動作）です。

## 実装

`shortcuts.rs` の `register()` 関数で一括登録しています。
`lib.rs` の `setup` フックから呼ばれます。

```rust
// shortcuts.rs の概略
pub fn register(app: &tauri::App) {
    // Shortcut オブジェクトを生成
    // with_handler() でイベントに応じたウィンドウ操作を記述
    // register() で OS に登録
}
```

ショートカットを追加・変更する場合は **`shortcuts.rs` のみ** を編集してください。

## ショートカットの追加手順

1. `shortcuts.rs` 内で `Shortcut::new(Some(Modifiers::...), Code::...)` で新しい Shortcut を生成
2. `with_handler` クロージャ内に `if shortcut == &new_shortcut_id { ... }` を追記
3. `entries` 配列に `(&new_shortcut, "表示名")` を追加

## 注意事項

### グローバルショートカットの競合

グローバルショートカットは OS 全体で有効なため、他のアプリと競合する可能性があります。
特に `Ctrl+Shift+N` は一部のブラウザやエディタで使われることがあります。
登録失敗時は `eprintln!` で警告を出すだけでアプリは継続動作します（致命的エラーにはしない）。

### macOS での Win+Alt+N

macOS では `Modifiers::SUPER` が Command キーにマップされます。
`Win+Alt+N` は `Cmd+Option+N` として動作します。

### プラットフォーム制約

`#[cfg(desktop)]` でガードしているため、モバイルビルドではショートカット登録は行われません。

### ショートカットプラグインのセットアップ失敗

`app.handle().plugin(...)` が失敗した場合（OS の権限不足など）は、
以降のショートカット登録をスキップして `return` します。
アプリの起動自体は継続するため、ショートカット機能だけが無効になります。

## フロントエンドから呼ぶ方法（代替手段）

グローバルでなく **アプリがフォーカスを持つ場合だけ動作する** ショートカットが必要な場合は、
フロントエンドの `keydown` イベントで処理し、必要に応じて `invoke("open_quick_note_window")`
を呼ぶ設計も可能です（`commands.rs` に既存コマンドあり）。

ただし、Workbench はバックグラウンドからでも素早くクイックノートを開けることを重視しているため、
グローバルショートカットを採用しています。
