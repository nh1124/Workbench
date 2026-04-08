# Native Desktop — セッション永続化（Secure Storage）

## 概要

ログインセッション（JWT アクセストークン・リフレッシュトークン）を
デスクトップ再起動後も保持するため、OS のセキュア資格情報ストアに保存しています。

ブラウザの `localStorage` や平文ファイルへの保存は避けており、
OS が提供する暗号化済みストアを使うことでトークン漏洩リスクを低減しています。

## 保存先

| OS | 保存先 | ターゲット名 |
|---|---|---|
| Windows | Windows Credential Manager（汎用資格情報） | `Workbench.Session` |
| macOS / Linux | **未実装**（現在は `Err(...)` を返す） | — |

## Tauri コマンド一覧

フロントエンドから `invoke` で呼びます。

| コマンド | 引数 | 戻り値 | 説明 |
|---|---|---|---|
| `secure_session_save` | `session_json: string` | `Result<(), string>` | セッション JSON を保存 |
| `secure_session_read` | なし | `Result<string \| null, string>` | 保存済みセッションを読み出す |
| `secure_session_clear` | なし | `Result<(), string>` | セッションを削除 |

## Windows 実装の詳細

`windows-sys` クレートで `CredWriteW` / `CredReadW` / `CredDeleteW` を直接呼んでいます。

- **格納形式:** セッションオブジェクトを JSON 文字列にシリアライズし、UTF-8 バイト列として `CredentialBlob` に格納
- **永続化スコープ:** `CRED_PERSIST_LOCAL_MACHINE`（ユーザーのマシン全体で永続化）
- **資格情報タイプ:** `CRED_TYPE_GENERIC`

`CRED_PERSIST_LOCAL_MACHINE` を選択している理由は、ユーザーがマシンを再起動してもセッションを
保持できるようにするためです。`CRED_PERSIST_SESSION` だとログアウトで消えます。

**実装箇所:** `secure_storage.rs` — `platform` モジュール（Windows 向け）

## macOS / Linux への対応方針

現時点では `save` / `clear` が `Err(...)` を返し、`read` が `Ok(None)` を返します。
フロントエンドは「セッションなし」として扱い、ログイン画面に遷移します。

将来対応する場合:

- **macOS:** Keychain Services（`Security.framework`）を `objc` または `security-framework` クレートで呼ぶ
- **Linux:** libsecret（GNOME Keyring）または `secret-service` クレートを使う

いずれも `secure_storage.rs` の `platform` モジュールを OS ごとに追記するだけで対応できます。
`commands.rs` とフロントエンド側の変更は不要です。

## 注意事項

- `session_json` の中身（トークン文字列など）はこのモジュールでは検証しません。
  何を保存するかはフロントエンド（UI）側の責任です。
- Windows Credential Manager の容量上限は 1 エントリあたり 2,560 バイトです。
  セッション JSON がこれを超える場合は別の保存戦略が必要です。
- `CredWriteW` は既存エントリを上書きします。
  初回保存と更新で API を分ける必要はありません。
