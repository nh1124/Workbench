# Workbench — ドキュメントインデックス

実装の意図・設計判断・注意点をまとめたドキュメント群です。
コードを変更する前にここを参照してください。

> システムアーキテクチャの全体像（サービス構成・認証モデル・エンドポイント）は
> リポジトリルートの [README.md](../README.md) に記載されています。

---

## ツリー

```
docs/
├── README.md                    ← このファイル（インデックス）
├── native/
│   ├── overview.md              ← Tauri デスクトップアプリ全体の説明・モジュール構成
│   ├── window-management.md     ← マルチウィンドウ・マルチインスタンスの設計
│   ├── shortcuts.md             ← グローバルキーボードショートカット一覧と実装方針
│   └── secure-storage.md        ← セッション永続化（Windows Credential Manager）
└── user_note/                   ← ユーザー向けメモ（別途整備予定）
```

---

## ドキュメント一覧

### ネイティブデスクトップ (`native/`)

| ドキュメント | 内容 |
|---|---|
| [native/overview.md](native/overview.md) | Tauri アプリの起動フロー・モジュール分割の方針 |
| [native/window-management.md](native/window-management.md) | ウィンドウの生成ルール・複数インスタンスの扱い・タスクバー操作 |
| [native/shortcuts.md](native/shortcuts.md) | 登録済みショートカット一覧・追加・変更の手順 |
| [native/secure-storage.md](native/secure-storage.md) | セッショントークンの保存先・プラットフォーム対応方針 |
