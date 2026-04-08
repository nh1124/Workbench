# Native Desktop — 概要

Tauri v2 を使った Windows デスクトップアプリです。
フロントエンドは `ui/` の React/Vite ビルド成果物を WebView に読み込んでいます。

## 起動フロー

```
main.rs
  └─ workbench_native_lib::run()          (lib.rs)
       ├─ tauri_plugin_single_instance    (二重起動制御)
       ├─ setup()
       │    ├─ tauri.conf.json 由来のウィンドウを全て閉じる
       │    ├─ window::open_new_main_window()   (メインウィンドウを再生成)
       │    └─ shortcuts::register()            (グローバルショートカット登録)
       └─ invoke_handler
            └─ commands モジュールの全コマンドを登録
```

`tauri.conf.json` にデフォルトウィンドウを定義しているが、**setup で一度閉じて作り直している**。
理由は `disable_drag_drop_handler()` が `WebviewWindowBuilder` の Rust API 経由でしか設定できないため
（JSON では指定不可）。詳細は [window-management.md](window-management.md) を参照。

## モジュール構成

```
src-tauri/src/
├── lib.rs              起動オーケストレーション（ここには副作用のないロジックは置かない）
├── main.rs             エントリポイント（lib.rs を呼ぶだけ）
├── window.rs           ウィンドウの生成・ラベル管理
├── shortcuts.rs        グローバルショートカットの登録
├── secure_storage.rs   Windows Credential Manager を介したセッション保存
└── commands.rs         #[tauri::command] — フロントエンドから invoke されるハンドラ
```

### 分割方針

- `lib.rs` は「何を・いつ初期化するか」だけを記述する。ビジネスロジックは各モジュールへ。
- ウィンドウ操作はすべて `window.rs` に集約し、ラベル生成もここで管理する。
- ショートカットの追加・変更は `shortcuts.rs` だけを触れば済むようにする。
- `commands.rs` は薄いラッパーであり、実処理は `window.rs` / `secure_storage.rs` に委譲する。

## Cargo 依存関係

| クレート | 用途 |
|---|---|
| `tauri` v2 | アプリフレームワーク |
| `tauri-plugin-single-instance` v2 | 二重起動の制御と新ウィンドウへのリダイレクト |
| `tauri-plugin-global-shortcut` v2 | グローバルキーボードショートカット |
| `windows-sys` v0.59 | Windows Credential Manager への低レベルアクセス |

## プラットフォーム対応

現在は **Windows のみ** を実運用対象として想定しています。

- `#[cfg(desktop)]` で desktop/mobile を分岐。モバイル向けの実装は現時点でスタブ。
- `secure_storage` は `#[cfg(target_os = "windows")]` で Windows 専用実装を提供し、
  他 OS では `Err(...)` を返すスタブになっています。

macOS や Linux への対応を追加する場合は `secure_storage.rs` の platform モジュールに
当該 OS 向け実装を足してください（Keychain / libsecret など）。
