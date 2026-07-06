# Workbench Maintenance Loop Implementation Plan

Status: P1+P2 実装完了(masterへマージ済み) — 次はP3。P2 UIのOwner受入とlive DB smokeが残
Last updated: 2026-07-06

関連文書:

- 方向性レビュー(本計画の元): [workbench-direction-review.md](../user_note/workbench-direction-review.md)
- 設計正本: [project-agent-context-design.md](../project-agent-context-design.md)
- 先行実装: [project-agent-context-implementation-plan.md](project-agent-context-implementation-plan.md),
  [workbench-local-client-sync-daemon-plan.md](workbench-local-client-sync-daemon-plan.md)

目的: 「変更発生 → 変更フィード → メンテキュー → 定期agent実行 → 人間レビュー(週次・一箇所)
→ 昇格/破棄 → 変更フィード → …」のループを閉じる。

---

## 1. Status Legend

- `[pending]`: 未着手
- `[in-progress]`: worker(Codex)が実装中
- `[review]`: root agent(Claude)のレビュー待ち
- `[approved]`: レビュー・検証済み、commit可能
- `[implemented]`: commit済み
- `[deferred]`: 今回の対象外としてfollow-upへ移動
- `[blocked]`: contract決定または依存実装待ち

## 2. Progress Dashboard

各フェーズの現在状態。詳細タスクは各フェーズのProgress Boardを参照。
**このダッシュボードとタスク状態はroot agentのみが更新する。**

| Phase | 内容 | 規模 | 依存 | Status | 進捗 |
|---|---|---|---|---|---|
| P0 | Contract freeze(§4の決定事項の承認) | - | - | `[approved]` | 2026-07-06 承認 |
| P1 | Lifecycle metadata + maintenance queue | 小 | P0 | `[implemented]` | 10/10 |
| P2 | 昇格フロー(レビューキューUI + confirm API) | 中 | P1 | `[implemented]` | 9/9 (Owner受入待ち) |
| P3 | 変更フィードMCP露出 + maintenance skill + digest手順 | 小〜中 | P0 (skill最終化はP1、digest手順はP4) | `[in-progress]` | 4/9 (core完了。skillはP4後) |
| P4 | usage_events計測 | 小 | P0 (queue統合はP1) | `[implemented]` | 7/7 |
| P6 | Capture client | 大 | P1+P2安定後 | `[deferred]` | 別contract文書で再開 |

注: 当初のP5(週次ダイジェスト自動生成)はCore実装としては削除した。ダイジェストは
外部ルーチン(cowork / Codex)がmaintenance skillの手順(§7.3)で生成する(D-107)。

## 3. 実装体制

### 3.1 役割

| 役割 | 担当 | 責務 |
|---|---|---|
| Owner | ユーザー | Gate P0承認、P2レビューUIの受入、最終判断 |
| Root agent | Claude (Claude Code) | 指示出し、diff review、検証実行、本文書の状態更新、commit作成 |
| Worker | Codex (MCP `codex` / `codex-reply`) | タスク単位の実装、handoff報告 |

### 3.2 進行ルール

- workerは本文書の該当フェーズ・タスクIDを指定して起動する。1 waveあたり同時1 worker
  (同一working treeを共有するため)。並列化する場合はroot agentがworktreeを分離する。
- workerはcontract(§4)を独断で変更しない。変更が必要な場合は差分案を報告し、
  root agent承認後に文書と実装を更新する。
- commitはroot agentがレビュー・検証後に作成する。
- branch: フェーズ単位で `codex/maintenance-p1` 〜 `codex/maintenance-p4` を推奨。

### 3.3 File ownership

| Workstream | Primary write scope |
|---|---|
| Projects domain | `services/projects/src/**` |
| Notes domain | `services/notes/src/**` |
| Core + MCP | `services/workbench-core/src/**` |
| UI | `ui/src/**` |
| Skill | `.agents/skills/workbench-maintenance/**` |
| Docs | root agentのみ本文書を更新 |

### 3.4 Handoff template

```text
Phase / Task IDs:
Branch / Base commit:
Files changed:
Contract deviations:
Verification commands / results:
Known risks / follow-ups:
Ready for root review: yes/no
```

## 4. Gate P0: Contract Freeze

Status: `[review]` — 以下の決定を承認後、P1着手可。

### 4.1 Decisions

```text
D-101 lifecycle metadataの適用先
- project_memory_entries と notes に4カラムを追加する。
- project_index_entries には追加しない(草案からの変更点)。
  理由: indexは派生データであり rebuild で全entryが再生成されるため、
  行に持たせたlifecycleはrebuildで消える。indexの鮮度は既存の
  content_hash / source_updated_at / indexed_at から queue read model が
  導出する(reason=source_changed)。

D-102 lifecycle_state の値と初期値
- 値: raw | triaged | curated | verified
- backfill: memory は authority=user_confirmed → verified
  (last_confirmed_at=updated_at)、それ以外 → triaged。notes → triaged。
- 新規作成のdefault: MCP経由のmemory append / note create → triaged。
  inbox的な取り込みは呼び出し側が明示的に lifecycleState=raw を渡す。

D-103 昇格(confirm)はUI経由のHTTPのみ
- confirm / snooze はMCP toolとして登録しない(design doc §11の先送り判断を維持)。
- MCPには「キューに載せる」操作(maintenance.flag)のみ許可し、
  「キューから外す」操作(confirm/snooze)はUI専用とする。
- 制約はtool未登録+skill記述で担保する。tokenレベルでのUI/agent識別は
  現行認証では不可能なため、hard enforcementはfollow-up(§11)とする。

D-104 maintenance queueの集約点
- 集約はCore(単一gateway)で行う。Projects / Notes 各serviceに
  queue用のread routeを追加し、Coreの GET /api/maintenance/queue が合成する。

D-105 変更フィードのconsumer cursor
- Core DBに sync_consumer_cursors (user_id, consumer_id) を追加する。
- sync-daemonは既存のローカルcursor管理のまま変更しない。
  consumer cursorはローカル状態を持てないMCP agent用。
- 配信はat-least-once。pull → 処理 → commit の2段階とし、
  重複処理は冪等な下流操作(flag/queue確認)で吸収する。
- best-effort対策: 差分駆動(高頻度) + queue read modelの全件導出(低頻度スイープ)の
  ハイブリッド。queueは毎回メタデータを全件走査して導出するため、
  それ自体がスイープとして機能する。

D-106 usage_events
- Core DBに単一テーブル usage_events を追加。記録は3種のみ:
  context_truncation / index_search(zero-hit検出用) / resource_read。
- fire-and-forget(記録失敗で元requestを失敗させない)。
- 最適化ロジックは作らない。集計read modelをqueue/digestの入力にするだけ。

D-107 週次ダイジェストの生成と配置
- Core側にdigest builder / schedulerは実装しない。週次ダイジェストは
  外部ルーチン(cowork / Codex)がworkbench-maintenance skillの手順(§7.3)に
  従って生成する。
- 材料は全てMCP read model(maintenance.queue.list / sync.changes.pull /
  maintenance.usage.summary)で賄い、digestのためのCore追加実装は行わない。
- 出力はdefault projectのnote。title `Workbench Weekly Digest <YYYY-Www>`、
  tag `workbench-maintenance`。同一期間の再生成は同titleのnoteを検索して
  更新する(冪等)。

D-108 P6 capture client
- 本計画の実装対象外。P1+P2安定後に別contract文書を作成する。
- 実装形態は決定済み(2026-07-06): sync-daemon内のcaptureモジュールとして実装し、
  制御UIはnative(Tauri)専用で露出する。別マイクロサービスやplugin基盤は作らない。
- 遵守する境界: (a) collectorは子プロセスまたはポーリング型収集で分離、
  (b) 生データは別DB(sync folder外)に置き機外へ出さない・要約のみoutbox経由で
  inbox(P1のlifecycleState=raw受け口)へ、(c) default off・opt-in・statusで可視化、
  (d) Core契約不変。詳細は§9。
```

### 4.2 HTTP contract (Core external routes)

```text
# P1
GET  /api/maintenance/queue
       ?kind=memory|note|brief|index_drift &reason=... &projectId=... &cursor=&limit=

# P2
POST /api/project-memories/:memoryId/confirm    body: { reviewAfter? }   (UI専用)
POST /api/project-memories/:memoryId/snooze     body: { until }          (UI専用)
POST /api/notes/:noteId/confirm                 body: { lifecycleState?, reviewAfter? } (UI専用)
POST /api/notes/:noteId/snooze                  body: { until }          (UI専用)
POST /api/maintenance/flags
       body: { target: {type: memory|note, id}, reason: conflict|manual, note? }

# P3
GET  /api/sync/changes?consumer=&cursor=&domains=&limit=
POST /api/sync/changes/commit                   body: { consumer, cursor }

# P4
GET  /api/maintenance/usage/summary?since=&until=
```

既存の memory supersede / archive、note update / delete は既存routeを使う(新設しない)。

### 4.3 MCP contract

```text
# P1
maintenance.queue.list          (read)

# P2
maintenance.flag                (write: review_reasonを立てるのみ。昇格・解除は不可)

# P3
sync.changes.pull               (read; consumer既定値 "maintenance-agent")
sync.changes.commit             (write: cursor永続化のみ)

# P4
maintenance.usage.summary       (read)
```

週次ダイジェスト用の専用toolは設けない。digestは既存のnotes系tool
(`notes.list` / `notes.create` / `notes.update`)で書く(D-107)。

confirm / snooze のMCP toolは**登録しない**(D-103)。

### 4.4 Queue item contract

```jsonc
// GET /api/maintenance/queue → 200
{
  "items": [
    {
      "id": "memory:pm_xxx",              // "<kind>:<resourceId>"
      "kind": "memory",                   // memory | note | brief | index_drift
      "projectId": "prj_xxx",
      "projectName": "WorkbenchDevelopment",
      "resourceId": "pm_xxx",
      "title": "…",                       // memory: bodyの先頭行 / note: title / brief: project名
      "excerpt": "…",                     // 本文先頭 ~200 chars
      "reasons": ["unconfirmed"],         // 下記enum、複数可
      "authority": "agent_observed",      // memoryのみ
      "lifecycleState": "triaged",        // memory/noteのみ
      "lastConfirmedAt": null,
      "reviewAfter": null,
      "updatedAt": "2026-07-01T…",
      "suggestedActions": ["confirm", "supersede", "archive"]
    }
  ],
  "nextCursor": null,
  "totals": { "byReason": { "raw": 3, "expired": 1, "unconfirmed": 7 } }
}
```

reason enum と導出条件:

| reason | 条件 | 由来 |
|---|---|---|
| `raw` | lifecycle_state = raw | stored |
| `expired` | review_after < now | derived |
| `unconfirmed` | authority=agent_observed かつ last_confirmed_at IS NULL かつ created_at が閾値超過 | derived |
| `conflict` | review_reason = conflict (agent/userがflag) | stored |
| `manual` | review_reason = manual | stored |
| `source_changed` | index entry: source_updated_at > indexed_at 等のdrift | derived (P1) |
| `brief_unmaintained` | brief空 or 文字数閾値未満 or 全active memoryより古い | derived |
| `unused` | 参照実績が閾値期間ゼロ(P4接続後に有効化) | derived (P4) |

閾値はenvで調整可能にする:
`WORKBENCH_MAINTENANCE_UNCONFIRMED_DAYS`(default 30) /
`WORKBENCH_MAINTENANCE_BRIEF_MIN_CHARS`(default 80) /
`WORKBENCH_MAINTENANCE_UNUSED_DAYS`(default 90)。

---

## 5. Phase P1: Lifecycle Metadata + Maintenance Queue

Branch: `codex/maintenance-p1` / Status: `[implemented]`
(commits: `b2de8de`, `2f90e6a`, `221be6c`)

実装ノート:

- 集約facadeの複合cursorは per-source cursor を base64url JSON に包んだ v1 形式。
- 全kind集約はheap-merge方式で1 itemごとに下流へ limit=1 リクエストを発行する。
  単一ユーザーでは十分だが、データ肥大時はソースごとのpage取得+メモリ内mergeへの
  最適化をfollow-up(§11)とする。
- MCPの `projects.memory.append` / `notes.create` の lifecycleState は raw|triaged のみ
  許可(curated/verifiedはUI/HTTP直呼びのuser pathでのみ設定可能)。
- 残リスク: PostgreSQL未起動のためDB-gated integration testsはskip。
  live DB / E2E smoke は§10.2受入時に実施する。

### 5.1 Schema

`services/projects/src/db.ts`(既存のidempotent initializationパターンに追記):

```sql
ALTER TABLE project_memory_entries
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'triaged'
    CHECK (lifecycle_state IN ('raw','triaged','curated','verified')),
  ADD COLUMN IF NOT EXISTS review_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_reason TEXT
    CHECK (review_reason IS NULL OR review_reason IN ('conflict','manual'));

-- backfill (初回のみ効果、再実行は無害)
UPDATE project_memory_entries
  SET lifecycle_state = 'verified', last_confirmed_at = updated_at
  WHERE authority = 'user_confirmed' AND last_confirmed_at IS NULL
    AND lifecycle_state = 'triaged';
```

`services/notes/src/db.ts`: notes に同じ4カラム(backfillはdefault triagedのみ)。

注: `expired` / `unconfirmed` / `source_changed` / `brief_unmaintained` は
derived reasonのためDBには保存しない(§4.4)。`review_reason` に保存するのは
flag操作による `conflict` / `manual` のみ。

### 5.2 Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| P1-1 | `[implemented]` | projects | memory 4カラム追加 + backfill + 型/zod schema更新 |
| P1-2 | `[implemented]` | projects | memory store: append/updateでlifecycle系フィールドを受理。list/contextのresponseへ含める |
| P1-3 | `[implemented]` | projects | queue read route追加: `GET /maintenance/memory-queue`(reason導出: raw/expired/unconfirmed/conflict/manual) + `GET /maintenance/brief-queue`(brief_unmaintained導出) + `GET /maintenance/index-drift`(source_changed導出) |
| P1-4 | `[implemented]` | notes | notes 4カラム追加 + create/update受理 + `GET /maintenance/note-queue` |
| P1-5 | `[implemented]` | core | internal clients拡張(projects/notes queue routes) |
| P1-6 | `[implemented]` | core | `GET /api/maintenance/queue` 集約facade(kind/reason/projectId filter、複合cursor、totals合算) |
| P1-7 | `[implemented]` | core | MCP `maintenance.queue.list` 登録(stdio/HTTP両方)。併せてMCPの `projects.memory.append` / `notes.create` へ lifecycleState(raw/triagedのみ)を追加 |
| P1-8 | `[implemented]` | projects/notes | unit/integration tests(§5.3)。DB-gated分は `RUN_PROJECTS_DB_TESTS=1` / `RUN_NOTES_DB_TESTS=1` で実行 |
| P1-9 | `[implemented]` | core | facade/MCP tests(§5.3) |
| P1-10 | `[implemented]` | root | レビュー・検証・commit・本文書更新(2026-07-06) |

### 5.3 Tests

- backfill後、user_confirmed memoryがverified + last_confirmed_at設定済みになる。
- owner Aのqueue itemsがowner Bに見えない。
- reason導出: raw / expired(review_after過去) / unconfirmed(閾値超過のagent_observed) /
  brief_unmaintained(空brief) がそれぞれqueueに載る。
- verified + review_after未来のmemoryはqueueに載らない。
- index drift: source_updated_at > indexed_at のentryが source_changed で載る。
- queueのpagination / filter / totalsが正しい。
- 既存のmemory list / context packが後方互換(新フィールドは追加のみ)。

### 5.4 Verification

```powershell
npm run build --workspace services/projects
npm run test --workspace services/projects
npm run build --workspace services/notes
npm run test --workspace services/notes
npm run build --workspace services/workbench-core
npm run test --workspace services/workbench-core
```

---

## 6. Phase P2: 昇格フロー(レビューキューUI + confirm API)

Branch: `codex/maintenance-p2` / Status: `[implemented]` / 依存: P1
(commits: `004d0c9`, `efe0fb4`, `3c4ce3c`。Ownerの実操作受入は§10.2で実施)

### 6.1 動作仕様

- confirm(memory): authority → `user_confirmed`、lifecycle_state → `verified`、
  last_confirmed_at = now、review_reason clear、optional reviewAfter(TTL)設定。
- confirm(note): lifecycle_state → 指定値(default `curated`)、last_confirmed_at = now、
  review_reason clear。
- snooze: review_after = until に設定するのみ(昇格しない)。
- supersede / archive / 破棄はUIから既存route(memory update/archive、note delete)を呼ぶ。
- confirm/snooze/flagはsync eventを記録する(project_context invalidationと同様のパターン)。

### 6.2 UI

- 新規page `/maintenance`(nav追加)。`ui/src/maintenance/` 配下にcomponents。
- queue一覧: reason / kind / project でfilter、totalsバッジ表示。
- item行: title + excerpt + reasons + authority/lifecycleバッジ
  (agent_observedをuser_confirmedと同じ見た目にしない — 既存UIの区別を踏襲)。
- item操作: 承認(confirm) / 編集して置換(supersede) / archive / 破棄 / snooze(期間選択)。
- 操作後はqueueから即時消えることを楽観更新で反映する。

### 6.3 Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| P2-1 | `[implemented]` | projects | memory confirm/snooze store + internal routes(`POST /project-memories/:id/confirm` 等) |
| P2-2 | `[implemented]` | notes | note confirm/snooze store + internal routes |
| P2-3 | `[implemented]` | projects/notes | flag store + internal routes(review_reason = conflict/manual設定。note?は行に永続化せず応答echoのみ、Coreがsync event payloadへ載せる) |
| P2-4 | `[implemented]` | core | external facade(§4.2のP2 routes) + sync event記録。MCPにはconfirm/snoozeを**登録しない** |
| P2-5 | `[implemented]` | core | MCP `maintenance.flag` 登録 |
| P2-6 | `[implemented]` | ui | `/maintenance` page: queue表示 + filter + totals |
| P2-7 | `[implemented]` | ui | item操作(confirm/supersede/archive/破棄/snooze) + 楽観更新 |
| P2-8 | `[implemented]` | all | tests(§6.4。confirm/snooze非登録auditは core maintenanceQueue.test.ts に固定) |
| P2-9 | `[implemented]` | root | レビュー・検証・commit・本文書更新(2026-07-06)。Ownerの実操作受入(§10.2)は未実施 |

### 6.4 Tests

- confirmでauthority/lifecycle/last_confirmed_atが正しく遷移し、queueから消える。
- 他ownerのmemory/noteをconfirmできない(404)。
- MCP tool一覧にconfirm/snoozeが存在しないことをtestで固定する
  (tool名のsnapshot/audit test)。
- flagはreview_reasonを立てるだけで、authority/lifecycleを変えない。
- UI: confirm後の楽観更新、agent_observedバッジ表示、filter動作。

### 6.5 Verification

P1のコマンドに加えて:

```powershell
npm run build --workspace ui
npm run test --workspace ui
```

---

## 7. Phase P3: 変更フィードMCP露出 + Maintenance Skill

Branch: `codex/maintenance-p3` / Status: `[pending]` /
依存: P0(skill最終化はP1+P2、digest手順のtool名照合はP4完了後)

### 7.1 Consumer cursor

Core DB(`services/workbench-core/src/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS sync_consumer_cursors (
  user_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, consumer_id)
);
```

- `GET /api/sync/changes`: cursor未指定時は保存済みconsumer cursorから継続。
  responseは既存 `listSyncEvents` の形式 + `nextCursor` + `consumer`。
  `project_context` domainのinvalidation event(`changed: ["brief"|"memory"|…]`)を
  そのまま流す(メンテ対象特定に使う)。
- `POST /api/sync/changes/commit`: 処理完了後にcursorを永続化(at-least-once)。
- sync-daemonの既存 `/api/sync/pull` とローカルcursorは変更しない。

### 7.2 workbench-maintenance skill

`.agents/skills/workbench-maintenance/`(`workbench-project` と同構成:
`SKILL.md` + `agents/openai.yaml` + `references/tool-contracts.md`)。

Core workflow:

```text
1. sync.changes.pull で前回以降の差分を取得する。
2. 差分から対象project / resourceを特定し、必要な本文だけを読む。
3. maintenance.queue.list で要レビュー項目を確認する。
4. 矛盾・陳腐化を発見したら maintenance.flag で印を付け、
   supersede案・archive案は既存toolで「提案」として下書きする
   (memory appendはagent_observedのまま。昇格はしない・できない)。
5. 処理が完了したら sync.changes.commit でcursorを進める。
6. 規範と実データの乖離(brief記載と実memory不一致)を代表パターンとして点検する。
7. 通常業務の書き込み(タスク更新等)はこのskillでは行わない。
```

### 7.3 週次ダイジェスト手順(skill内)

Core側にdigest builderは実装しない(D-107)。週次ダイジェストは外部ルーチン
(cowork / Codex)が本skillを起動して生成する。SKILL.mdへ次を明記する。

構成(4セクション、この順):

1. 変更サマリ — `sync.changes.pull` の期間集約(domain別件数 + 主要変更)
2. 要レビュー項目 — `maintenance.queue.list` の現在値(reason別件数 + 上位項目)
3. 昇格候補 — unconfirmedのagent_observed memory(古い順)
4. 計測サマリ — `maintenance.usage.summary`(truncation率 / zero-hit query / unused上位)

命名・冪等規約:

- 出力先: default projectのnote。title `Workbench Weekly Digest <YYYY-Www>`、
  tag `workbench-maintenance`。
- 冪等更新: 書き込み前に同titleのnoteを検索し、存在すれば `notes.update`、
  なければ `notes.create` する(同一期間の再実行でnoteを重複させない)。
- P4未実装の環境では計測サマリを「未計測」と明記して縮退する。

定期実行はOwnerがcowork / Codexのルーチンとして登録する(Core外・本計画のタスク外)。
運用上、「今週のdigest noteが無い」ことをルーチン停止のシグナルとして扱う。

### 7.4 Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| P3-1 | `[implemented]` | core | sync_consumer_cursors table + store |
| P3-2 | `[implemented]` | core | `GET /api/sync/changes` + `POST /api/sync/changes/commit`(user bearer auth専用。未知domainは400) |
| P3-3 | `[implemented]` | core | MCP `sync.changes.pull` / `sync.changes.commit` 登録 |
| P3-4 | `[implemented]` | core | tests: cursor分離(daemon非干渉)、at-least-once、owner isolation |
| P3-5 | `[pending]` | skill | skill scaffold + SKILL.md(500行未満、workflow §7.2) |
| P3-6 | `[pending]` | skill | 週次ダイジェスト手順(§7.3)をSKILL.mdへ追記(tool名はP4完了後に照合) |
| P3-7 | `[pending]` | skill | tool-contracts.md を実装済みMCP schemaと照合 |
| P3-8 | `[pending]` | root | skill forward-test(§7.5) |
| P3-9 | `[pending]` | root | レビュー・検証・commit・本文書更新 |

### 7.5 Skill forward-test

期待結果を教えない別sessionで:

1. 「先週から変わったものを整理して」→ changes.pull → 対象特定 → queue確認の順で動く。
2. 矛盾を見つけたケース → flagを立て、confirmを試みない。
3. queueが空のケース → 全件読み込みに走らず終了する。
4. WorkbenchDevelopmentのbrief乖離(「バグはpitfallへ記録」と定めるが該当memoryなし)を
   検出して報告する。
5. 「週次ダイジェストを作って」→ §7.3の構成・命名で生成し、
   再実行時は同titleのnoteを更新する(新規noteを増やさない)。

---

## 8. Phase P4: usage_events 計測

Branch: `codex/maintenance-p4` / Status: `[pending]` / 依存: P0(queue統合のみP1)

### 8.1 Schema (Core DB)

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('context_truncation','index_search','resource_read')),
  project_id TEXT,
  source_service TEXT,
  resource_type TEXT,
  resource_id TEXT,
  query_text TEXT,
  hit_count INTEGER,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_type_created
  ON usage_events(user_id, event_type, created_at DESC);
```

### 8.2 記録点(Core facade / MCP内、全てfire-and-forget)

1. `context_truncation`: `projects.context.get` / `GET /api/projects/:id/context` の
   response truncation metadataに切られたsectionがある場合、section名をmetadataへ記録。
2. `index_search`: `projects.index.search` とcontext.getの`q`付き呼び出し。
   `hit_count` を記録(0がzero-hit query = 欠けている知識の直接シグナル)。
3. `resource_read`: MCPのread系tool(artifacts.item.get / notes.get / mindmaps.get /
   wbs.get 等)で本文が開かれたとき、resource参照を記録。

### 8.3 集計read model

- `GET /api/maintenance/usage/summary?since=&until=` / MCP `maintenance.usage.summary`:
  - truncation発生率(section別)
  - zero-hit query上位(頻度順)
  - 参照回数上位/ゼロのリソース
- queue統合(P1依存): index entryのうち`WORKBENCH_MAINTENANCE_UNUSED_DAYS`(default 90)超
  参照ゼロのものを reason=`unused` としてqueueへ載せる。

実装ノート(D-106補足、2026-07-06決定):

- `unused` の導出はCore-projects間のcross-DB joinを避けるため、
  `project_index_entries` へ `last_read_at TIMESTAMPTZ` を追加し、Coreがresource_read
  記録時にprojectsの `POST /maintenance/index-read-marks` をbest-effortで叩いて更新する。
  queueの `unused` は他reasonと同様projects側のderived reasonとして実装する
  (`indexed_at` がN日より古く、かつ `last_read_at` がNULLまたはN日超)。
- `last_read_at` はrebuildで消えるが、消えた場合は「N日間unused判定されない」方向に
  倒れるだけで安全(D-101の懸念と異なりlifecycleの正本ではない)。
- unused項目のqueue上のkindは `index_drift`(index entry由来ソースの再利用)。
- 計測はMCP経由のread系toolのみを対象とする(UI閲覧は計測しない)。

### 8.4 Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| P4-1 | `[implemented]` | core | usage_events table + store(insertはfire-and-forget) |
| P4-2 | `[implemented]` | core | 記録点1: context truncation(facade/MCP共通helper) |
| P4-3 | `[implemented]` | core | 記録点2: index search + hit_count(context.getのq付きも記録) |
| P4-4 | `[implemented]` | core | 記録点3: resource_read(artifacts/notes/mindmaps/wbsのread系MCP tools) + index read mark |
| P4-5 | `[implemented]` | core | usage summary read model(HTTP + MCP、default直近30日) |
| P4-6 | `[implemented]` | core+projects | queueへの`unused` reason統合(last_read_at方式、§8.3実装ノート) + tests |
| P4-7 | `[implemented]` | root | レビュー・検証・commit・本文書更新(2026-07-06)。normalizeOwner不整合とread mark巻き戻りをレビューで修正 |

---

## 9. Phase P6: Capture Client — `[deferred]`

本計画では実装しない(D-108)。実装形態は2026-07-06に決定済み。
再開条件と骨子を記録する。

- 再開条件: P1+P2が安定稼働し、レビューキューの運用が週次で回っていること。
- 実装形態: **sync-daemon内のcaptureモジュール** + **native(Tauri)専用の制御UI**。
  - 同格の別clientではなくdaemonに同居する。理由: local client identity(secure
    storage)、outbox(オフライン耐性のある要約push)、Tauriライフサイクル管理、
    Settings UI、loopback statusを再利用できるため。「Coreを太らせない」原則は
    daemon内モジュールでも維持できる。
  - collectorは子プロセスまたはポーリング型収集(アクティブウィンドウのサンプリング等)
    から始め、captureの異常がファイル同期を道連れにしない構造にする。
  - 生ログはmanifest.sqliteと分離した専用DB(sync folder外のapp-data領域)へ。
    生データは機外へ出さず、ローリング削除(保持N日)する。outboxへ載せるのは
    要約のみで、投入先はP1のlifecycleState=raw受け口(inbox)のみ。Core routeは
    追加しない。
  - default off。native Settingsで明示的に有効化し、OS権限要求も有効化時のみ。
    daemon `/status` にcapture状態を含め、「静かに記録されている」状態を作らない。
    制御UIはTauri検出時のみ表示。成果物(inboxの要約note)は通常のnoteとして
    web UIからも見える。
  - 既知のトレードオフ: daemonのtoken権限(sync.push等)を共有し、capture専用の
    狭いscopeは持てない。個人利用の間は許容し、問題になれば同格clientへ抽出する。
  - captureモジュールは `services/sync-daemon/src/capture/**` に閉じ、sync内部への
    importを禁止する(継ぎ目を保ち、将来の同格client抽出を安価にする)。
  - plugin基盤は作らない。local_clients + scoped capabilities + Core APIを
    「周辺機器規約」として文書化するに留め、3つ目の周辺機器が現れた時点で
    共有lib抽出を検討する。
- 着手時に別contract文書(`docs/imple/workbench-capture-client-plan.md`)を作成する。

---

## 10. 全体検証

### 10.1 コマンド

```powershell
npm run build            # full workspace
npm run test --workspace services/projects
npm run test --workspace services/notes
npm run test --workspace services/workbench-core
npm run test --workspace ui
npm run test:e2e:api     # Docker環境起動時
```

Verification log(root agentが各フェーズcommit時に更新):

| Phase | Command set | Status | Notes |
|---|---|---|---|
| P1 | projects/notes/core build+test | `[implemented]` | 2026-07-06: projects 12 pass/2 skip、notes DB test skip、core 52 pass/13 skip(DB未起動分)。live DB smokeは§10.2で実施 |
| P2 | projects/notes/core/ui build+test + full build | `[implemented]` | 2026-07-06: ui 16 files/98 tests pass、core 56 pass/13 skip、full workspace build成功。live DB smokeとOwner UI受入が残 |
| P3 | core build+test | `[implemented]` | 2026-07-06: core 61 pass/14 skip。skill forward-testはlive環境で実施 |
| P4 | projects/core build+test | `[implemented]` | 2026-07-06: projects/core全pass(DB-gated skip)。live計測smokeは§10.2で実施 |

### 10.2 Manual acceptance(全フェーズ完了時)

1. agent_observed memoryを追加 → queueに`unconfirmed`(閾値を一時的に0日へ)で載る
   → `/maintenance` UIでconfirm → user_confirmed/verifiedになりqueueから消える。
2. review_after付きmemoryが期限超過で`expired`として再浮上する。
3. 空briefのプロジェクトが`brief_unmaintained`で載る。
4. Artifactを直接更新 → index driftが`source_changed`で載る → rebuildで解消する。
5. maintenance skillが差分駆動で動く: 変更 → sync.changes.pull → flag → commit。
6. WorkbenchDevelopmentのbrief乖離(pitfall未記録)をskillが検出・報告する(最初のテストケース)。
7. zero-hit queryを発生させ、usage summaryに現れる。
8. skill手順(§7.3)で週次ダイジェストを2回生成しても、同titleのnoteが
   更新されるだけで重複しない。
9. confirm/snoozeがMCP tool一覧に存在しない。
10. 別ownerのqueue/usage/digestが見えない。

## 11. Deferred / Follow-ups

- confirm APIのtokenレベルでのUI/agent識別(hard enforcement)。現状はMCP tool未登録 +
  skill規律で担保(D-103)。
- memory自動昇格(modelによる) — design doc §11の先送り判断を維持。
- usage_eventsのretention/rollup(単一ユーザーの間は不要。肥大時にpartition/削除を検討)。
- maintenance queue集約(P1-6)のパフォーマンス最適化 — 現状は全kind集約時に
  1 itemごとの下流リクエスト(heap-merge)。データ肥大時はソースごとのpage一括取得 +
  メモリ内mergeへ切り替える。
- Core内のdeterministic digest builder — ルーチン生成(§7.3)が不安定または
  トークン高コストになった場合に再検討する。read model群(queue / changes / usage)は
  残るため、追加実装は小規模で済む。
- P6 capture client(§9)。
- 12プロジェクトのbrief品質是正そのもの(ツールが提供する検出結果を使う運用タスク)。

## 12. 進捗の見方(Owner向け)

- **§2 Progress Dashboard** — フェーズ単位の現在地。「進捗 n/m」は各Progress Boardの
  `[approved]`+`[implemented]` 件数。
- **各フェーズのProgress Board** — タスク単位の状態。`[review]` はCodexの実装が
  終わりClaudeのレビュー待ち、`[implemented]` はcommit済みを意味する。
- **§10.1 Verification log** — フェーズごとの検証結果。
- 状態更新はroot agent(Claude)がレビュー・commitのタイミングで行い、
  `Last updated` を書き換える。
