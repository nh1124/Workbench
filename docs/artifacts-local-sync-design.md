# Artifacts ローカル運用・同期設計（Local-First）

## 1. 目的

Artifacts を「サーバー依存のオンライン専用」から、以下を満たす Local-First 構成へ拡張する。

- オフラインでも `tree取得 / folder作成 / note作成 / item更新削除 / upload/download` が可能
- ローカル編集内容を後からサーバーへ同期
- ユーザー × プロジェクト単位で管理分離
- 既存 UI（`ArtifactsPage`）の API 契約を極力維持し、段階導入できること

---

## 2. スコープ

### In Scope

- デスクトップ版 Workbench における Artifacts のローカル保存
- 双方向同期（ローカル→サーバー、サーバー→ローカル）
- 競合時の解決ルール（MVP は deterministic ルール）
- 既存 Project デフォルト仕様との整合

### Out of Scope（初期）

- Web ブラウザ版のみでの完全ローカル運用
- CRDT のようなリアルタイム共同編集
- ファイル差分マージ（バイナリ）

---

## 3. 要件

### 3.1 機能要件

- ローカルで以下を即時反映（ネットワーク不要）
  - ツリー取得
  - フォルダ作成
  - ノート作成
  - ノート/ファイル/フォルダ更新（title/path/project/tags/content）
  - 単体・複数削除
  - アップロード
  - ダウンロード
- プロジェクト未指定時は Projects サービス既存仕様に準拠
  - ユーザー default project 優先
  - 無効時は fallback `default` project
- Shared Utility をユーザー単位で保持（プロジェクト非依存データ）

### 3.2 非機能要件

- ローカル操作の応答: 体感 100ms 未満（メタデータ操作）
- 同期失敗時に編集内容を喪失しない（Queue 永続化）
- 冪等同期（同一操作の再送で壊れない）
- 監査可能な同期ログ（最低限: op_id, status, last_error）

---

## 4. 推奨アーキテクチャ

## 4.1 方式

UI から見える `/api/artifacts/*` 契約は維持し、`workbench-core` でデータソースを切り替える。

- `ArtifactsGateway`（新規インターフェース）
  - `RemoteArtifactsGateway`（現行 artifacts service 呼び出し）
  - `LocalArtifactsGateway`（ローカル SQLite + ファイルストア）
  - `SyncedArtifactsGateway`（Local を主、バックグラウンド同期）

これにより `ArtifactsPage.tsx` 側の変更を最小化できる。

## 4.2 実行モード

- `remote`: 現行どおり（完全サーバー）
- `local-only`: ローカルのみ（同期なし）
- `local-sync`（推奨）: ローカル主 + 同期ワーカー

環境変数例:

- `ARTIFACTS_RUNTIME_MODE=remote|local-only|local-sync`

---

## 5. ローカル管理仕様

## 5.1 ディレクトリ構造（論理）

ユーザーごとに分離し、Project 依存/非依存を分ける。

- `user/{userId}/shared-utility/...`（project 非依存）
- `user/{userId}/projects/{projectId}/...`（project 依存）

## 5.2 物理保存（推奨）

- メタデータ: SQLite（`artifacts-local.db`）
- 実体ファイル: content-addressed blob（`blobs/{sha256}`）
- プレビュー: `previews/{itemId}.pdf`

content-addressed にすることで重複保存を抑え、move/rename をメタデータ更新で処理可能。

## 5.3 SQLite テーブル（MVP）

- `artifact_items_local`
  - `item_id`, `owner_id`, `project_id`, `namespace_kind(shared|project)`, `kind`, `path`, `parent_path`, `title`, `tags_json`, `content_markdown`, `mime_type`, `size_bytes`, `blob_hash`, `version`, `updated_at`, `deleted_at`
- `artifact_sync_queue`
  - `op_id`, `owner_id`, `item_id`, `op_type`, `payload_json`, `base_version`, `status(pending|running|failed)`, `retry_count`, `last_error`, `created_at`
- `artifact_sync_state`
  - `owner_id`, `cursor_token`, `last_pulled_at`, `last_pushed_at`

`deleted_at` を導入し、削除も差分同期対象にする。

---

## 6. 同期仕様

## 6.1 同期トリガ

- アプリ起動時
- ネットワーク復帰時
- 一定間隔ポーリング（例: 30-60秒）
- 手動同期（UI ボタン）

## 6.2 同期順序

1. Push: `artifact_sync_queue` の pending を順次送信  
2. Pull: `cursor_token` 以降のサーバー差分取得  
3. マージ適用後、cursor 更新

## 6.3 サーバー API（追加）

`services/artifacts` に同期専用 API を追加する。

- `POST /artifacts/sync/push`
  - body: `{ ops: SyncOp[], clientId, deviceId }`
  - response: `{ applied, rejected, serverCursor }`
- `GET /artifacts/sync/pull?cursor=...`
  - response: `{ changes: ArtifactChange[], nextCursor }`

## 6.4 競合解決（MVP）

- ノート本文: `base_version` 一致時のみ上書き。ズレた場合:
  - サーバー版採用 + ローカル差分を `*.conflict.md` として退避
- ファイル: Last-Write-Wins（`updated_at` 比較） + 旧版は conflict 名で残す
- move/rename と delete 競合:
  - delete 優先（孤児化防止）

---

## 7. Projects との整合

- ローカル操作でも `projectId` 未指定時は `default` 解決ルールを使う
- fallback `default` project は削除不可・変更不可として扱う
- Project 名変更時は `project_id` 不変、表示名のみ同期更新

---

## 8. UI 仕様（追加）

- ステータス表示:
  - `Synced / Pending n / Offline / Conflict`
- 同期エラー時:
  - 通知 + 再試行ボタン
- コンフリクト発生時:
  - ツリー上に conflict マーク
  - 差分比較導線（MVP は「両方保存」）

---

## 9. セキュリティ・運用

- セッショントークンは既存 `secure_storage` 利用
- ローカル DB/Blob の保存先はユーザー領域配下
- 任意: DB 暗号化キーを secure storage で保管（Phase 2 以降）
- 同期ログは個人情報を含まない形で保持

---

## 10. 段階実装プラン

## Phase 0: 契約固定（1-2日）

- `ArtifactsGateway` インターフェース定義
- 現行 API との互換テスト作成

完了条件:

- 既存 UI が `remote` モードで無変更動作

## Phase 1: Local Store 実装（3-5日）

- SQLite スキーマ作成
- Local CRUD（tree/folder/note/update/delete/upload/download）
- ファイル Blob 保存

完了条件:

- オフラインで主要操作が完結

## Phase 2: workbench-core 統合（2-3日）

- `local-only` / `local-sync` 切替実装
- `/api/artifacts/*` を Gateway 経由へ統一

完了条件:

- フラグ切替で remote/local が透過的に動く

## Phase 3: artifacts service 同期 API（4-6日）

- `/sync/push` `/sync/pull` 実装
- tombstone/差分取得対応
- 冪等性（`op_id`）対応

完了条件:

- 同じ op 再送で二重適用されない

## Phase 4: 同期ワーカー（3-4日）

- Push/Pull ループ
- retry/backoff
- conflict ファイル生成

完了条件:

- オフライン編集→再接続で整合復帰

## Phase 5: UI/運用仕上げ（2-3日）

- 同期ステータス表示
- conflict 導線
- 障害時の復旧手順ドキュメント

完了条件:

- ユーザーが「同期状態」と「失敗時の対処」を理解できる

---

## 11. 受け入れテスト（最小）

- オフラインで note 作成/更新/削除 → 再接続後サーバー反映
- オフラインで file upload → 再接続後 download 可能
- 2端末同一ノート更新で conflict 退避が作られる
- Project 未指定保存が default/fallback へ入る
- Shared Utility 配下のデータが project 切替非依存で見える

---

## 12. リスクと先回り対策

- リスク: hard delete だと差分同期不可
  - 対策: `deleted_at` tombstone 導入
- リスク: path 基準同期は rename/move に弱い
  - 対策: `item_id` 主体で同期し path は属性として扱う
- リスク: 大容量ファイル同期遅延
  - 対策: メタデータ先行同期 + Blob 遅延同期（必要時優先）

