# AgentSkills 定期メンテナンス基盤強化 実装計画

Status: 計画作成済み、実装中
Last updated: 2026-07-19

関連文書:

- [workbench-maintenance-loop-plan.md](workbench-maintenance-loop-plan.md)（maintenance queue / sync.changes の先行実装）
- [workbench-local-client-sync-daemon-plan.md](workbench-local-client-sync-daemon-plan.md)（sync event の別consumer）
- Skill契約: [.agents/skills/workbench-maintenance/references/tool-contracts.md](../../.agents/skills/workbench-maintenance/references/tool-contracts.md)

---

## 1. 背景

AgentSkills プロジェクト（`936c62d5-1d5a-42af-979b-696c3e4d0526`、Skillルート `skills/`）の
定期メンテナンスを Claude Cowork が Primary Writer として無人実行している。
Workbench は薄いデータ・知識管理基盤に留め、スケジューラ／エージェントランタイムは実装しない。

既存 Cowork consumer: `cowork-agent-skills-incremental`（cursor 773付近。**リセット・巻き戻し禁止**）。

## 2. 現状調査結果（2026-07-19）

### 2.1 sync change の保存形式

- `services/workbench-core/src/syncStore.ts`
  - `sync_events` (core DB): `id BIGSERIAL`（= cursor、**owner横断の全体連番**）、`user_id`,
    `domain`, `resource_id`, `action`, `version`, `payload_json JSONB`, `created_at`。
  - domain: `projects | notes | artifacts | tasks | project_context`。
  - action: `create | update | delete | upsert`（**move は存在しない**。path変更は update）。
  - index: `idx_sync_events_user_id (user_id, id ASC)` のみ。projectId / path 列は無い。
  - delete イベントの payload は `{deleted: true, deletedAt, resourceDeletedAt}` のみで
    **projectId / path を持たない**。
  - update イベント（HTTP facade経由）は `payload.resource` に更新後リソース全体
    （note の場合 `contentMarkdown` 込み）、`payload.patch` にリクエストボディを持つ。
- `sync_consumer_cursors` (core DB): `(user_id, consumer_id) PK`, `cursor TEXT`, `updated_at`。
  scope 概念なし。作成は `sync.changes.commit` の upsert のみで「現在headから開始」する初期化APIは無い。
- `pullSyncChanges` (`syncChanges.ts`): consumer / cursor / domains / limit のみ。
  cursor未指定なら保存済み consumer cursor、無ければ `"0"`（全履歴）。

### 2.2 イベント発行経路の重要な非対称（調査で判明）

- **HTTP facade**（`httpServer.ts` の `/api/artifacts/**`）: `recordSyncEventBestEffort` で
  `artifacts` domain イベントを発行する。
- **Core MCP**（`registerArtifactsTools.ts`）: `artifacts` domain イベントを**発行しない**。
  `project_context` domain の invalidation イベント（`resource_id = projectId`,
  `payload.entityId = artifactItemId`, `changed: ["index"]`）のみ発行する。
- したがって Cowork（MCP経由）が Skill を更新しても artifacts イベントは流れず、
  project_context invalidation（path情報なし）しか観測できない。
  scoped pull（pathPrefix）を意味のあるものにするには MCP 経路の artifacts イベント発行が必要。

### 2.3 Artifacts データモデル

- `services/artifacts/src/db.ts`: `artifact_items` は `owner_username` スコープ、
  `project_id`, `kind (folder|note|file)`, `title`, `path`, `parent_path`, `version INTEGER`,
  `content_markdown`。**version履歴テーブルは存在しない**（現在versionの整数のみ）。
  過去version本文は保存されていない → 任意version間diffは既存データから生成不能（§9.1）。
- maintenance 系の列（review_reason 等）は artifacts には無い。

### 2.4 maintenance queue / flag

- `maintenanceQueue.ts`: kind = `memory | note | brief | index_drift` の合成キュー。
  各 kind は内部サービスの HTTP エンドポイント（例: notes `/maintenance/note-queue`）から取得し、
  base64url の複合カーソルで k-way merge する。kind 追加は
  `MAINTENANCE_QUEUE_KINDS` + `SOURCE_REASONS` + `defaultMaintenanceQueueSources` +
  internalClients の追加で拡張できる設計。
- `maintenanceActions.ts` の `maintenance.flag`: target type = `memory | note`（notesサービスのNote）。
  notes は行上の `review_reason` 列に書く方式（open/resolved のライフサイクル・履歴なし）。

### 2.5 MCP 登録・テスト構成

- MCP tool は `services/workbench-core/src/mcp/register*.ts` で dot 区切り名で登録
  （`maintenance.flag`, `sync.changes.pull` 等）。契約文書は
  `.agents/skills/workbench-maintenance/references/tool-contracts.md`。
- テスト: `tsx --test`（node:test）。DB は mock pool を注入する unit スタイル
  （`syncStore.test.ts`, `maintenanceQueue.test.ts`）+ 一部 integration
  （notes `notesMaintenance.integration.test.ts`）。API E2E は `infra/scripts/e2e-api.mjs`。

## 3. 問題（依頼の再掲・調査で裏取り済み）

1. Artifact を maintenance flag できない（memory / note のみ）。
2. 新規 consumer が cursor 0 から全履歴を舐めるしかない（head初期化APIなし）。
3. `sync.changes.pull` に projectId / pathPrefix / resourceType / action /
   includeContent / includePatch フィルターがない。
4. Artifact version 間 diff API がない（そもそも過去version本文が未保存）。
5. Skill 体系検証がエージェント実装依存（Phase 3 設計のみ）。

## 4. 対象・非対象

### 対象（Phase 1）

- P1-A: sync event envelope の denormalize（projectId / resourceType / path / previousPath）
  + MCP artifact 変更経路での artifacts イベント発行
- P1-B: `sync.changes.consumer.initialize`（current head 初期化・scope bind）
  + `sync.changes.pull` のスコープフィルター
- P1-C: Artifact maintenance flag / queue / resolve
- P1-D: MCP schema・ドキュメント更新

### 対象（Phase 2、別commit）

- P2-A: `maintenance.lease.acquire / renew / release`（軽量排他）
- P2-B: `artifacts.versions.diff` は**今回実装しない**（§9.1 に制約と将来方式を記載）

### 非対象

依頼書の「非対象」全項目（スケジューラ、エージェントランタイム、意味的統合、
LLM品質判定、Cowork Scheduled Task再実装、Gitミラーリング、確認済みSkill一括書換え）。
consumer の**再初期化・巻き戻しAPIも今回は実装しない**（危険操作として分離、将来の明示的別API）。

## 5. API 設計

### 5.1 `sync.changes.consumer.initialize`（新規）

推奨案どおりの名称を採用。

入力:

```jsonc
{
  "consumer": "string (1..100)",        // 必須
  "startAt": "current",                 // 現状 "current" のみ許可（enum、将来拡張用）
  "scope": {                            // 任意。指定時は consumer に永続 bind
    "projectId": "string",
    "pathPrefix": "string",
    "domains": ["artifacts", "project_context"],
    "resourceTypes": ["note", "folder"],
    "actions": ["create", "update", "delete"]
  }
}
```

出力:

```jsonc
{
  "consumer": "…",
  "cursor": "812",                 // 初期化時の head（既存なら保存済みcursor）
  "alreadyInitialized": false,     // 既存consumerの場合 true（状態は変更しない）
  "scope": { … } | null,
  "initializedAt": "ISO"
}
```

挙動:

- head 取得と cursor 保存は `INSERT … SELECT COALESCE(MAX(id),0) FROM sync_events WHERE user_id=$1
  … ON CONFLICT DO NOTHING` の単一文で atomic に行う。初期化後に発生したイベントは
  `id > head` なので取りこぼさない。`startAt: current` は過去イベントを一切返さない。
- 既存 consumer（`cowork-agent-skills-incremental` 含む）に対して呼んでも
  **cursor / scope を一切変更せず**既存状態を `alreadyInitialized: true` で返す（idempotent）。
  既存 scope と異なる scope を指定した場合は 409 相当のエラー。
- owner (`user_id`) スコープ必須。他ownerのconsumerには到達不能（PKが `(user_id, consumer_id)`）。

### 5.2 `sync.changes.pull` 拡張（後方互換）

追加入力（すべて optional）: `projectId`, `pathPrefix`, `resourceTypes[]`, `actions[]`,
`includeContent` (default **true**), `includePatch` (default **true**)。

- 既存引数のみの呼出は完全に従来どおり（default true はこのため。最小開示より互換を優先し、
  Cowork には明示 `includeContent: false` を利用例として案内する）。
- `includeContent: false`: payload から `resource.contentMarkdown` 等の本文フィールドを除去し
  `contentLength` を付す。`includePatch: false`: `payload.patch` を除去。
- **cursor は scope 内位置ではなく change stream 全体の位置**（`sync_events.id`）。
- pagination / 停滞防止: scan window 方式。

  ```sql
  WITH scanned AS (
    SELECT … FROM sync_events WHERE user_id=$1 AND id>$2 ORDER BY id ASC LIMIT $scanLimit
  ) SELECT … FROM scanned WHERE <scope filters> ORDER BY id ASC LIMIT $limit
  ```

  - `limit` は **matching event 数**。`scanLimit = clamp(limit * 10, limit, 2000)`（過剰スキャン上限）。
  - `nextCursor` = matched が limit 件に達したら最後の matched id、
    達しなければ**最後に scan した id**（対象外イベントのみでも cursor が前進し停滞しない）。
- scope 判定:
  - projectId: denormalized `project_id` 列。NULL（旧イベント等）は payload からの
    best-effort 抽出（`payload->'resource'->>'projectId'` / project_context は `resource_id`）に
    fallback し、**それでも不明なイベントは除外しない**（at-least-once優先。取りこぼしより過剰配信）。
  - pathPrefix: `path` または `previous_path` の**どちらかが前方一致すれば in scope**
    （move の移動前後両方に一致。delete は削除前 path で判定可能）。不明(NULL)は除外しない。
  - resourceTypes / actions: 一致 or 不明は除外しない、の同方針。
- scope bind との関係: consumer に scope が bind 済みの場合、
  無指定 pull には bound scope を適用し、**異なる scope を指定した pull は 400**（推奨設計を採用）。
  unscoped consumer（既存全consumer）は per-request フィルターを許可する
  （§7.2 の migration 方針。commit すると対象外イベントはその consumer からは再配信されない旨を
  ドキュメントに明記）。

### 5.3 event envelope（sync_events 追加列）

`sync_events` に nullable 列を追加: `project_id TEXT`, `resource_type TEXT`,
`path TEXT`, `previous_path TEXT`。

- 新規イベントはイベント発生時点の値を書く（delete は削除前スナップショットから、
  update で path が変わる場合は `previous_path` + `path` 両方）。
- `recordSyncEvent` の互換 API は維持し、metadata はオプショナル引数で受ける。
- **MCP artifact 変更経路（registerArtifactsTools）にも artifacts domain イベント発行を追加**
  （§2.2 のギャップ解消。payload 形は facade と同形: `source: "core-mcp"`, `resource`, `patch`）。
  これは挙動追加だが、local client sync daemon にとっても「MCP編集が同期されない」既存ギャップの
  修正であり、at-least-once 契約内。
- HTTP facade / sync-push / project_context invalidation 経路にも同じ metadata を付与。
  project_context invalidation は `project_id = resource_id`, `resource_type = "project_context"`。

### 5.4 `maintenance.flag` 拡張 + `maintenance.review.resolve`（新規）

- `maintenance.flag` の target type に `artifact` を追加（値は artifact item id）。
  Notes サービスの Note (`note`) と Artifacts の note kind の曖昧さは
  「`artifact` = artifact item（kind問わず id 指定）」で回避。folder / file も flag 可
  （最低要件は note、実装上 kind 制限を設けない。理由: 誤配置フォルダ等もレビュー対象になり得る）。
- 保存先: notes の行内 `review_reason` 方式ではなく、**artifacts DB の新テーブル
  `artifact_maintenance_flags`**（open/resolved ライフサイクル + 監査履歴の要件のため）。

  ```sql
  CREATE TABLE artifact_maintenance_flags (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL,
    artifact_item_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('conflict','manual')),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    flagged_by TEXT NOT NULL,
    flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT
  );
  -- 同一itemの open flag は最大1件
  CREATE UNIQUE INDEX ux_artifact_maintenance_flags_open
    ON artifact_maintenance_flags(owner_username, artifact_item_id) WHERE status='open';
  CREATE INDEX idx_artifact_maintenance_flags_owner_status
    ON artifact_maintenance_flags(owner_username, status, flagged_at DESC);
  ```

- 重複 flag: open flag が既にある item への flag は open 行の reason / note / flagged_at を
  更新する（新規行を作らない）。resolve 後の再 flag は新規行（履歴が残る）。削除はしない。
- artifacts サービス新エンドポイント（internal, x-api-key + owner）:
  - `POST /artifacts/items/:id/maintenance-flag`（存在しないitem → 404、他owner → 404）
  - `POST /artifacts/items/:id/maintenance-flag/resolve`（open flagなし → 404 or no-op明示）
  - `GET /maintenance/artifact-queue`（open のみ、keyset cursor、queue item 契約は §5.5）
- Core MCP:
  - `maintenance.flag` target.type `artifact` → artifacts client 経由。`flaggedBy` は
    auth context の username + source（`core-mcp`）。
  - `maintenance.review.resolve`（新規）: `{ target: { type: "artifact", id }, note? }`。
    現時点の対象は artifact のみ（memory / note の解決は既存 confirm / snooze UI 経路が正本のため。
    schema 上 enum を artifact のみで公開し将来拡張可能にする）。
- `maintenance.queue.list` に kind `artifact` を追加。queue item は既存共通形 +
  `path`, `artifactKind`, `version`, `flaggedBy`, `flaggedAt` を含める
  （`resourceId` = artifact item id, title, projectId, reason, note(excerpt), 要件充足）。
- flag / resolve 時に `artifacts` domain の sync event（update, operation付き）を発行し監査可能にする。

### 5.5 maintenance queue item（artifact kind）

```jsonc
{
  "id": "artifact:<artifactItemId>",
  "kind": "artifact",
  "projectId": "…", "projectName": "…",
  "resourceId": "<artifactItemId>",
  "title": "…", "excerpt": "<note or reason>",
  "reasons": ["conflict"],
  "updatedAt": "<flaggedAt>",
  "suggestedActions": ["resolve"],
  "path": "skills/…", "artifactKind": "note", "version": 4,
  "flaggedBy": "…", "flaggedAt": "ISO"
}
```

### 5.6 Phase 2: `maintenance.lease.*`

core DB `maintenance_leases`:

```sql
CREATE TABLE maintenance_leases (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  holder TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  renewed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, key)
);
```

- `acquire {key, holder, ttlSeconds}`: 期限切れ or 同一 holder なら取得（idempotent）、
  他 holder の有効 lease は 409。`renew` / `release` は holder 一致必須。
  TTL 切れで自動的に取得可能（release 失敗からの復旧）。単純な排他のみでランタイム化しない。

## 6. 推奨案からの変更点（理由付き）

| 推奨案 | 採用 | 理由 |
|---|---|---|
| `actions: ["create","update","move","delete"]` | `move` は**追加しない**（`create/update/delete/upsert`） | 既存 `SyncAction` に move が無く、追加は全consumer/UIの action 分岐に影響。move は「path が変わる update」であり、`previousPath`/`path` の両方を pathPrefix 判定に使うことで要件（移動前後どちらでも捕捉）を満たす |
| `resourceTypes: ["note","folder"]` | 採用（値は `note/folder/file` + 他domainの型名） | artifacts の kind をそのまま `resource_type` に記録 |
| flag 対象は最低 `kind: note` | kind 制限なし（folder / file も可） | 誤配置フォルダ等もレビュー対象になり得る。制限する積極的理由がない |
| `maintenance.flag.clear` | `maintenance.review.resolve` を採用 | 「clear」は履歴削除を示唆する。resolved 行を残す監査要件に合う名称 |
| notes 同様の行内 review_reason | 専用テーブル | open/resolved + 監査履歴 + 重複flag制御の要件のため |
| `artifacts.versions.diff` | 実装しない | 過去version本文が未保存で正確な diff を生成できない（§9.1） |
| includeContent 既定値 | true（現状維持） | 後方互換優先。最小開示は呼出側の明示 false で達成 |

## 7. Migration・後方互換

### 7.1 DB migration（すべて additive、`CREATE/ALTER … IF NOT EXISTS` の既存起動時方式）

- core: `sync_events` に 4 列追加(nullable)、`sync_consumer_cursors` に
  `scope_json JSONB`, `initialized_at TIMESTAMPTZ` 追加(nullable)。
  index: `idx_sync_events_user_project (user_id, project_id, id) WHERE project_id IS NOT NULL` を追加
  （scan window 方式の主フィルタは id 範囲なので必須ではないが、将来の project 別走査用）。
- artifacts: `artifact_maintenance_flags` 新設。
- core: `maintenance_leases` 新設（Phase 2）。
- **既存イベントの backfill は行わない**。旧イベントは NULL のまま、pull 時に payload から
  best-effort 抽出 + 「不明は除外しない」で対応（誤除外なし・オンライン負荷なし）。
- **`sync_consumer_cursors` の既存行（cursor 値含む）には一切触れない**。

### 7.2 consumer scope migration

- 既存 consumer は unscoped のまま維持。scope bind は `initialize` を明示的に呼んだ consumer のみ。
- unscoped consumer の per-request フィルターは許可（Cowork 既存 consumer が
  projectId/pathPrefix を毎回明示する運用）。bind 済み consumer への異なる scope 指定は 400。
- 暗黙の scope 縮小は発生しない（bind は明示操作のみ）。

### 7.3 API 後方互換

- `sync.changes.pull` / `sync.changes.commit` / `maintenance.flag` / `maintenance.queue.list`:
  既存引数のみの呼出は応答形・挙動とも不変（新規フィールドの追加のみ）。
- `maintenance.queue.list` の kind 無指定は全 kind 対象のため、artifact flag 追加後は
  artifact 項目が混ざる（追加的変更として許容。既存 UI は kind を無視しても表示可能な共通形）。

## 8. セキュリティ

- すべての新規 API は `user_id` / `owner_username` スコープ（JWT → auth context）。
  consumer 名だけでは他 owner の cursor に到達不能（PK が user_id 複合）。
- artifact flag / resolve / queue は artifacts サービス側で owner_username 照合（他ownerは404）。
- filter 引数は WHERE の追加条件のみで、owner 条件を緩める経路がない事をテストで担保。
- includeContent=false で MCP レスポンスから本文を除去（payload削減 + 最小開示）。
- flag / resolve / initialize は sync event（監査履歴）を発行。lease は audit 対象外（軽量ロック）。

## 9. 既知の制約・残課題

### 9.1 Artifact version diff（Phase 2-B、未実装）

`artifact_items` は現在 version の整数と本文しか持たず、過去 version 本文が存在しない。
sync_events の `payload.resource` から部分復元は可能だが、(a) MCP経路イベント欠落（今回修正）以前の
期間は穴がある、(b) 保持期間契約がない、ため「任意 version 間の一貫した diff」は推測実装になる。
今回は実装せず、将来方式として `artifact_item_versions`（item_id, version, content_markdown,
metadata_json, changed_by, created_at; note kind のみ・上限付き）の追加を提案として記載する。

### 9.2 Phase 3（Skill Registry / Validator）設計方針のみ

- AgentSkills 固有の frontmatter 規則（skill_id, status, authority, 階層Index規則）は
  Workbench core に埋め込まず、**汎用の artifacts ツリー検証プリミティブ + 外部（Cowork/Codex）の
  Skill 固有ルール**の分担とする。core に置くのは高々
  `artifacts.tree.validate`（存在参照・親Index直下規則のような構造検証の汎用部分）程度。
- `priority` / `updated_at` 欠落 9 件は自動補完しない（意味変更のため）。正本は
  frontmatter とし、欠落の扱い（optional か、既定 normal か）は Owner 決定後に
  別 migration として扱う。validator は「不足の報告」まで。
- Index rebuild は dry-run 出力（変更対象・現在・提案・差分・自動適用可否）を先行。

## 10. テスト戦略

- 単体（mock pool, node:test, `tsx --test`）: 依頼書のテスト要件
  「sync consumer初期化 8項目 / scoped pull 15項目 / Artifact maintenance 8項目 / MCP 5項目」を
  それぞれ P1-B / P1-B / P1-C / P1-D のタスクに割り当てる。
- 回帰: 既存 `syncStore.test.ts`, `maintenanceQueue.test.ts`, `syncEventsHttp.test.ts`,
  `localClientHttpApi.test.ts`, notes integration が全て green であること。
- 型: 各 workspace `npx tsc --noEmit`。
- 統合シナリオ（live 環境、実装後に手動 + 可能なら e2e-api）:
  依頼書 Step 5 の 11 手順（head初期化 → 対象外更新 → Skill更新 → scoped pull → commit →
  再取得なし → flag → queue → resolve → 履歴確認）。

## 11. ロールバック

- 各 commit は独立 revert 可能な論理単位（§12）。
- DB 変更は additive のみ。revert 後も追加列・追加テーブルは無害に残置
  （必要なら手動 DROP 手順を各 commit message に記載）。
- 既存 consumer cursor は非破壊のためロールバックで失われる状態がない。

## 12. Codex への作業分割・commit 分割

| Wave | 内容 | 主対象 | commit |
|---|---|---|---|
| W1 (P1-A) | sync_events envelope 列 + recordSyncEvent 拡張 + 全発行経路の metadata 付与 + MCP artifacts イベント発行 | workbench-core | feat(core-sync): denormalized change-event envelope + MCP artifact emission |
| W2 (P1-B) | consumer initialize + scoped pull + scope bind | workbench-core | feat(core-sync): consumer head initialization and scoped pull |
| W3 (P1-C) | artifact_maintenance_flags + artifacts endpoints + core queue/flag/resolve 統合 | artifacts, workbench-core | feat(maintenance): artifact flag/queue/resolve lifecycle |
| W4 (P1-D) | MCP schema 最終化 + tool-contracts.md / README 系ドキュメント + Cowork 利用例 | mcp, docs | docs(mcp): AgentSkills consumer + scoped pull contracts |
| W5 (P2-A) | maintenance lease | workbench-core | feat(maintenance): owner-scoped maintenance leases |

- 各 Wave は Codex 実装 → Claude レビュー（要件適合・認可・cursor境界・race・互換）→ 修正 → 次へ。
- 独立レビュー（Codex への最終レビュー依頼）は W4 後に diff 全体で実施。

## 13. Progress Board

| Task | Status |
|---|---|
| 調査（§2） | [done] 2026-07-19 |
| 計画書作成 | [done] 2026-07-19 |
| W1 envelope + emission | [pending] |
| W2 initialize + scoped pull | [pending] |
| W3 artifact maintenance | [pending] |
| W4 MCP schema + docs | [pending] |
| W5 lease (Phase 2) | [pending] |
| 統合テスト（Step 5 シナリオ） | [pending] |
| 最終レビュー・commit | [pending] |
