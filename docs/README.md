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
├── artifacts.md                 ← Artifacts ページの設計・PDF ビューアー・ショートカット
├── artifacts-local-sync-design.md ← Artifacts のローカル運用・同期設計
├── project-agent-context-design.md ← Project index / memory / network / agent skill 設計草案
├── imple/
│   ├── project-agent-context-implementation-plan.md ← 並列実装・承認・統合計画
│   ├── project-context-sync-export-plan.md ← Project contextのread-only local cache / one-way export計画
│   └── workbench-local-client-sync-daemon-plan.md ← Local client / sync daemon 実装計画
├── native/
│   ├── overview.md              ← Tauri デスクトップアプリ全体の説明・モジュール構成
│   ├── window-management.md     ← マルチウィンドウ・マルチインスタンスの設計
│   ├── shortcuts.md             ← グローバルキーボードショートカット一覧と実装方針
│   └── secure-storage.md        ← セッション永続化（Windows Credential Manager）
└── user_note/                   ← ユーザー向けメモ（別途整備予定）
```

---

## ドキュメント一覧

### フロントエンド

| ドキュメント | 内容 |
|---|---|
| [artifacts.md](artifacts.md) | Artifacts ページの設計・PDF ビューアー・ページ別コメント・ショートカット |
| [artifacts-local-sync-design.md](artifacts-local-sync-design.md) | Artifacts の Local-First 化（ローカル管理・同期・競合解決・段階実装計画） |
| [pdf-comments-server-design.md](pdf-comments-server-design.md) | PDF コメントのサーバー移行設計（DB スキーマ・API・同期戦略・マイグレーション） |

### Agent / Project context

| ドキュメント | 内容 |
|---|---|
| [project-agent-context-design.md](project-agent-context-design.md) | Artifactのprimary / secondary Project所属、Projectごとのindex・memory、Project network、agent skillの設計草案 |
| [imple/project-agent-context-implementation-plan.md](imple/project-agent-context-implementation-plan.md) | Artifact複数Project所属を含む、複数agentのbranch分割・担当境界・承認gate・test・commit計画 |
| [imple/project-context-sync-export-plan.md](imple/project-context-sync-export-plan.md) | Project contextのread-only local cache、sync安全性、one-way `.workbench` exportの契約・branch・承認gate |

### ネイティブデスクトップ (`native/`)

| ドキュメント | 内容 |
|---|---|
| [native/overview.md](native/overview.md) | Tauri アプリの起動フロー・モジュール分割の方針 |
| [native/window-management.md](native/window-management.md) | ウィンドウの生成ルール・複数インスタンスの扱い・タスクバー操作 |
| [native/shortcuts.md](native/shortcuts.md) | 登録済みショートカット一覧・追加・変更の手順 |
| [native/secure-storage.md](native/secure-storage.md) | セッショントークンの保存先・プラットフォーム対応方針 |
