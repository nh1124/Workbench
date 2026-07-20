# Workbench Analyser Service Plan (2026-07)

Status: `[done]` — 2026-07-20 完了（insights → analyser 全面再設計・実装・本番 cutover・正本反映・OAuth 修正すべて完了）
Last updated: 2026-07-20

背景: Analyser を「Workbench 内の知識と PC 上の作業活動を観測し、改善候補を抽出し、
人間の承認または事前承認済みの安全な自動操作ポリシーを経て、持続的な知識へ変える」
横断ツールとして再設計する。Analyser は推論モデルを内蔵せず、観測・設定・ルーチン・
実行状態・サマリ・提案・操作記録のみを保持する。推論と Workbench リソース操作は
外部 Agent（Claude Code / Cowork / Codex 等）が Skill に従って行う。特定 Agent
ベンダーに依存するコードを Analyser 本体へ入れない。

`services/insights` は部分拡張せず `services/analyser` に置換する。
**本計画は workbench-insights-service-plan と maintenance-loop の Review 側
（queue/flag/lease/review UI/usage_events）を置き換える。** Core は引き続き唯一の
公開 HTTP/MCP 境界。後方互換 alias（`insights.*` / `maintenance.*`）は残さない。

Status legend は maintenance-loop-plan §1 と同一。状態更新は root のみ。

## 1. 設計決定（非交渉）

```text
AN-D1 責務境界
- Analyser がスケジュール正本・cursor・lease/run state を持つ。外部 Agent の
  automation は coarse polling で analyser.routines.claim を呼ぶだけ。
- Analyser は LLM API を呼ばず、Agent provider SDK を依存に追加しない。
- sync_events は同期正本として維持。Workbench mutation の観測は Core 内の
  projector が専用 scoped consumer で読み、metadata/resource refs のみを
  Analyser へ idempotent に転送する（本文/patch/payload はコピーしない）。
- MCP/HTTP access metadata は Core の中央 wrap（registerTools 呼び出し点の
  decorator + HTTP middleware）で一度だけ計測。handler への散発 logging 禁止。
- PC activity / file metadata は sync-daemon から Core 経由。screenshot 画像は
  常にローカル限定（サーバへ送らない。API/MCP から画像を返さない）。

AN-D2 承認と自動操作
- summary / proposal / observation の作成に承認不要（Analyser 内の分析記録）。
- Workbench resource への操作は二経路:
  (1) 事前承認済み高確信操作 — Skill と automationPolicy の両方が許可し、
      deterministicTarget / currentEvidence / policyAllowed /
      concurrencyProtected / reversibleOrNonDestructive を全て満たす場合のみ
      既存 domain tools で直接実施。実施後に再読・検証し operation record。
  (2) 不確実な操作 — proposal 化。delete / primary membership removal /
      bulk / 本文大幅上書きは per-operation rule がない限り常に proposal。
- automationPolicy(owner-scoped): enabled=true, requireHighConfidence=true,
  destructiveAllowed=false, bulkAllowed=false。operation kind allowlist 初期値:
  artifact_move, artifact_metadata_update, artifact_secondary_membership_add,
  progress_note_upsert。UI からユーザーのみ変更可。Agent は read のみ。
- Agent は proposal を自分で approved にできない。approve/reject は UI user path
  のみ。approval provenance を記録する。

AN-D3 観測データ境界
- raw observation は操作メタデータ + resource reference まで。
  request/response/tool arguments/本文/patch/prompt/clipboard/keystroke/
  screenshot・OCR 全文/token・secret/（opt-in なしの）window title を保存しない。
- metadata は source/action ごとの allowlist serializer で構築。
- unknown/unconfigured source は fail closed。
- summary/proposal は推論結果なので本文保持可（evidence resource refs 添付、
  source body の大量複製・secret 禁止）。

AN-D4 収集設定（owner default + machine override、相互独立）
- workbenchChanges: off|metadata (default metadata)
- mcpAccess / uiAccess: off|mutations|reads_and_mutations (default mutations)
- agentSessionEvents: off|explicit_only (default explicit_only)
- foregroundAppCapture / foregroundAppUpload: bool (default false、既存 opt-in
  は migration で維持)
- windowTitleCapture / windowTitleUpload: bool (default false)
- localFileEvents: off|metadata (default off) / localFileUpload: bool (false)
- screenshots: off|local_only (default off)
- source ごとの retention days(server raw 30d, 範囲 1..90 / local screenshot
  7d, 範囲 1..30)、project/resourceType/local root の allow/deny +
  excludePatterns。
- disabled source は producer 側で生成停止 + ingest 側でも拒否の二重 gate。
- collection settings の write は user UI/HTTP path のみ。Agent MCP には
  read-only effective settings のみ公開。
- daemon local 設定と server effective policy が食い違う場合は厳しい方を採用。

AN-D5 スケジュール
- schedule は interval(minutes) か cron-like のどちらか一つ + IANA timezone 必須。
- cron は自前の制限サブセット(5 field: min hour dom mon dow、`*`・数値・
  カンマ列挙のみ)。Intl ベースの wall-clock 計算。Asia/Tokyo と DST の test 必須。
- 外部 scheduler ライブラリ / broker / workflow engine は追加しない。

AN-D6 スリムさ
- 新常駐サービスは services/analyser のみ。projector/cleanup は既存 Node
  process 内の timer + DB lease。
- action JSON の汎用 interpreter を作らない。operation kind は allowlist enum。
- 互換 wrapper を残さず、cutover 後に旧経路を削除する。
```

## 2. データモデル（services/analyser、own PostgreSQL）

service_accounts は他サービスと同一パターン（core_user_id → hash id）。
全表 owner(service_account_id) scope。created/updated timestamps、必要表に
optimistic concurrency version。

- `analyser_machines`: machine_key unique(owner,key)、display_name、platform、
  last_seen_at（旧 insights machines と同形）
- `analyser_collection_policies`: owner default 行 + machine override 行
  (machine_id nullable)。AN-D4 の全項目 + retention + filters。version、updated_by
- `analyser_automation_policies`: AN-D2 のフィールド。version、updated_by
- `analyser_observations`: seq BIGSERIAL(cursor 用)、id UUID、source、action、
  actor_kind(user|agent|system)、machine_id?、project_id?、occurred_at、
  received_at、resource_refs JSONB[{service,resourceType,resourceId,
  pathSnapshot?}]、metadata JSONB(allowlist 済み)、source_event_id?、
  dedupe_key、expires_at。unique(owner, dedupe_key)
- `analyser_routines`: key unique(owner,key)、name、skill_key、skill_version、
  schedule_kind(interval|cron)、schedule_expr、timezone、enabled、next_run_at、
  committed_cursor(observation seq)、retry policy(max_retries, backoff_minutes)
- `analyser_runs`: routine_id、status(claimed|processing|completed|failed)、
  holder、lease_expires_at、policy_snapshot JSONB、pending_read_cursor、
  error_summary?、started/finished
- `analyser_summaries`: period_start/period_end、kind、title、body_markdown、
  metrics JSONB、evidence_refs JSONB、routine_key?、run_id?、version。
  unique(owner, kind, period_start, period_end)
- `analyser_proposals`: kind、title、body_markdown、evidence_refs、
  proposed_action JSONB(kind + params、allowlist 検証)、confidence_evidence
  JSONB、status(open|approved|rejected|executed|superseded)、approval
  provenance(user/approved_at)、version
- `analyser_operations`: operation_kind、approval_basis(policy|proposal:<id>)、
  before_refs/after_refs、result、run_id?、agent 識別、idempotency_key
  unique(owner,key)
- `analyser_publications`: source(summary|proposal, id)、target_ref
  (note|artifact + id)、content_hash。unique(owner, source_kind, source_id,
  target_kind, content_hash) で重複 export 防止

retention cleanup（raw observation の期限削除）は Analyser 内の軽量
housekeeping timer。summary/proposal/operation/publication は消さない。

## 3. ルーチン実行契約

1. `analyser.routines.claim` — due+enabled を一件 atomic に claim
   （`FOR UPDATE SKIP LOCKED`）。key 指定可。runId / routine / skill key /
   effective collection policy / committed cursor を返す。due なしは null。
2. `analyser.observations.pull` — runId に対し committed cursor 以降を keyset
   pagination で返す（content なし）。run の pending_read_cursor のみ前進。
3. Agent は summary/proposal を idempotent upsert し、高確信操作を既存 domain
   tools で実施した場合のみ operations.record。
4. `analyser.routines.complete` — pending→committed cursor atomic 前進 +
   next_run_at 再計算。
5. `analyser.routines.fail` — cursor 前進なし。error summary + retry/backoff。
6. heartbeat + lease expiry で crash recovery。same-run retry idempotent、
   別 run 同時実行は排他。

初期 seed routine（idempotent、設定で無効化・頻度変更可）:
daily-work-summary / progress-record-maintenance / artifact-classification /
workbench-knowledge-maintenance / weekly-workbench-digest /
agent-skills-materialization

## 4. Core surface（公開名は analyser.* のみ）

MCP tools（annotations で read-only/write を正しく宣言）:

```text
analyser.status.get            analyser.settings.get (effective, read-only)
analyser.observations.list     analyser.observations.pull
analyser.routines.list         analyser.routines.claim
analyser.routines.heartbeat    analyser.routines.complete
analyser.routines.fail
analyser.summaries.list        analyser.summaries.get
analyser.summaries.upsert
analyser.proposals.list        analyser.proposals.get
analyser.proposals.create      analyser.proposals.update
analyser.operations.record     analyser.publications.record
```

- Agent は collection policy を更新できない。proposal approve/reject は UI
  user path のみ。approved proposal 実施後の executed 記録は Agent 可。
- summary/proposal の Note/Artifact export は Core が既存 domain client で
  orchestration し `analyser_publications` に idempotent 記録（UI/Agent 双方、
  provenance 区別）。
- Core HTTP は UI/sync-daemon 用の同等 REST routes（/api/analyser/*）。
  内部 Analyser endpoint は x-api-key + bearer JWT の既存規約。
- 全 surface に auth/owner isolation、pagination、input bounds、version
  conflict、service unavailable の test。

## 5. 収集経路

- **Workbench changes**: Core projector が consumer `analyser-projector` で
  sync_events を batch 読み → metadata/refs のみ ingest。Core 起動中の定期
  実行 + 手動 flush hook。projector 失敗は Core mutation を失敗させない。
  sourceEventId で idempotent。
- **MCP access**: httpServer/mcpServer の registerTools 呼び出し点で
  server.registerTool を wrap する decorator 一箇所で計測。tool name、
  read/mutation、成否、error class、duration、actor kind、抽出 refs のみ。
  arguments/response は送らない。reads は設定が reads_and_mutations の時のみ。
- **UI/HTTP access**: express middleware 一箇所。health/auth/OAuth/settings
  secret routes 除外。
- **Agent session**: explicit_only。Agent が開始/終了/成果 refs を明示報告した
  場合のみ保存。
- **PC activity / local files**: sync-daemon の sampler/idle/SQLite/identity/
  excludePatterns を再利用し、raw metadata upload + local status/settings に
  絞る。daemon 内 Markdown daily summary 生成・autoPublish・summary upload は
  削除。集計は Analyser の deterministic query API。file watcher は明示 root
  のみ・metadata のみ。screenshot は local_only 維持。

## 6. UI（旧 Insights/Maintenance UI を単一 Analyser 画面へ統合）

- Overview: 最終成功 run、次回予定、失敗 routine、未読件数、open proposal、
  source 別収集状態
- Activity: period/machine/source/project filter、server-side aggregate、
  raw observation metadata/resource links（本文は存在しないことを明示）
- Summaries: 一覧・詳細・期間・evidence refs・Note/Artifact export
- Proposals: status 別、根拠、proposed action、approve/reject、export、実行記録
- Settings: source 別設定、machine override、retention、allow/deny、
  routine schedule/enabled、automation policy
- 収集有効化時に何が保存・upload されるかを設定ごとに明記。screenshot
  `local_only` を明瞭表示。approve/reject/settings は user auth path で監査。

## 7. Skills（AgentSkills 正本 + ローカル materialization）

- `workbench-analyser-cycle`: claim → pull → focused reads → summary/proposal
  → high-confidence op → verify → record → complete/fail
- `workbench-maintenance`: proposal ベースの knowledge freshness/contradiction/
  index drift/brief slimness 処理へ書き換え
- `workbench-project`: 高確信 direct op と proposal の境界を追記
- `workbench-agent-skills-materialize`: 正本 → ローカル一方向反映
  （manifest: artifact id/path/version/content hash、same hash no-op、
  ローカル編集の逆同期なし、未反映変更時は上書きせず conflict、temp dir +
  atomic replace、adapter 分離、壊れた相対 link 検出）
- Skill には Agent 固有 syntax を埋め込まず、`analyser.*` と既存 Core tool
  contract を記載。

## 8. 移行と削除（新経路のテスト通過後）

1. 旧 insights DB を日時付き backup（pg_dump）。
2. データ移行: machines → analyser_machines、直近 retention 内の
   activity_samples → pc_activity observations。content-heavy summary は raw に
   変換せず legacy backup のまま。旧 open maintenance item → analyser proposal
   （idempotent migration）。
3. 削除（compatibility alias なし）:
   - services/insights 一式、insights.* MCP/HTTP/client/型/UI/env/scripts
   - derived_observations、daemon の旧 daily summary/autoPublish/upload 経路
   - Core usage_events + usageInstrumentation + maintenance.usage.summary
     （projectsClient.markIndexEntriesRead の index 既読反映は維持）
   - maintenance queue/flag/lease/review resolve + MCP tools + Review UI
   - memory/note の review_reason/review_after/lifecycle_state/
     last_confirmed_at（未処理項目を proposal へ移した後、notes/projects の
     schema/code/UI から削除）
4. 維持: sync_events、project context/index、Artifacts/Notes/Memory tools、
   optimistic concurrency、Artifact membership semantics、project memory の
   authority/status/provenance/supersede/archive、sync-daemon identity/
   local SQLite/screenshots/excludePatterns。
5. infra: insights-db → analyser-db（container workbench-analyser-db、
   db analyser_db、volume analyser_pgdata）。移行期間の並存のため
   ANALYSER_PORT=4109 / analyser-db host port 5551 を恒久採用し、旧 4108/5550
   の番号再利用はしない（churn 回避）。root scripts / start_*.sh /
   auto_update.sh / env samples / README 更新。旧 insights-db を起動し続けない。

## 9. テスト・受入（§13 of 元プロンプト準拠）

- Collection/privacy: mutation→metadata only 観測 / replay 重複なし /
  mcpAccess=mutations で read 非保存 / screenshot local_only + 他 OFF の独立性 /
  foreground ON + upload OFF / disabled source の二重拒否 / owner・machine・
  project isolation / retention cleanup / allow-deny filter
- Routine: atomic claim（同時 claim は一つ）/ fail 時 cursor 不動 + 再読可能 /
  complete でのみ cursor + nextRunAt 前進 / lease expiry・heartbeat・idempotent
  retry / Asia/Tokyo + DST
- Agent workflow: progress summary 保存 / 一意 Artifact の移動 + 検証 + record /
  複数候補は proposal / Agent は self-approve 不可 / export 二重実行で重複なし
- Maintenance/UI: contradiction・stale・brief oversized・index drift が proposal
  として見える / 5 タブが実データで動く / 旧 UI/API/tool への dead link なし
- Build/runtime: 影響 workspace typecheck+test / root+UI build / daemon build /
  compose config + analyser-db 起動 migration / Core・Analyser health +
  MCP analyser.* live smoke / 再起動後の状態保持

## 10. Wave 分割と Progress Board

体制: Claude=指揮・レビュー・commit、Codex(MCP)=worker（1 wave ≒ 1 commit、
30 分以内、workspace-write / approval never / Do NOT commit）。

| ID | Status | Scope | Task |
|---|---|---|---|
| AW-1 | `[implemented]` | services/analyser | scaffold + DB schema 全表 + auth + provisioning + health + package/tsconfig + .env.example + compose analyser-db + workspace 配線（insights は cutover まで並存）(commit d66e213) |
| AW-2 | `[implemented]` | services/analyser | machines / collection policies / automation policies / observations store（idempotent ingest・list・aggregate・retention cleanup・windowTitle 二重 gate）+ tests |
| AW-3 | `[implemented]` | services/analyser | schedule module（cron subset + tz + DST tests）+ routines/runs store（claim/heartbeat/complete/fail/seed）+ tests |
| AW-4 | `[implemented]` | services/analyser | summaries / proposals / operations / publications store + tests |
| AW-5 | `[implemented]` | services/analyser | httpServer 全 routes + zod 検証 + route tests（残: automation policy stored version の read 公開 → AW-13 で対応） |
| AW-6 | `[implemented]` | core | analyserClient + provisioning + /api/analyser/* facade（machines/ingest は syncAccess 認可） |
| AW-7 | `[implemented]` | core | MCP analyser.* tools 登録 + annotations + tests（18 tools、approve/reject/settings-write なし） |
| AW-8 | `[implemented]` | core | sync_events projector（consumer `analyser-projector` + 60s timer + /api/analyser/projector/flush、payload 非転送、未 provisioning は skip）+ tests |
| AW-9 | `[implemented]` | core | MCP wrap + HTTP middleware の access 計測（allowlist・二重 gate・analyser.*/auth/sync/oauth 除外・60s settings cache・best-effort batch flush）+ tests |
| AW-10 | `[implemented]` | sync-daemon | 設定粒度化（windowTitleCapture/Upload 追加・autoPublish 削除）+ uploader を analyser ingest へ（server 効果ポリシー fail-closed gate）+ summarizer/summary 経路全削除 |
| AW-11 | `[implemented]` | ui | api.ts analyser client + AnalyserPage 5 タブ骨格 + Overview + Activity（本文非表示の明示、resource ref リンク） |
| AW-12 | `[implemented]` | ui | Summaries + Proposals（approve/reject/supersede、409 対応、実行記録 lookup。export は publication pipeline 実装後に活性化） |
| AW-13 | `[implemented]` | ui, analyser | Settings（collection/automation/machine override/retention/routines、per-control 収集内容 caption、automation version read 追加） |
| AW-14a | `[implemented]` | core, ui | summary/proposal → Note/Artifact export orchestration（sha256 publication dedupe、approved/executed proposal のみ、UI Export dialog） |
| AW-14b | `[implemented]` | migration | 移行スクリプト 2 本 + runbook。ローカルで実行済み（service_accounts 9 件、activity はローカル空。実データ移行は cutover 時）。maintenance→proposals は Core 稼働時に実行 |
| AW-15a | `[implemented]` | core, insights, infra | services/insights 削除、insights.*/maintenance.* MCP・HTTP・client・provisioning・usage_events・maintenance queue/lease/actions 削除（markIndexEntriesRead は indexReadTracking.ts に保存）、infra から insights-db/INSIGHTS_* 全除去。既存 DB の usage_events/maintenance_leases 表は残置（追加削除は cutover 時判断） |
| AW-15b | `[implemented]` | ui | 旧 UI 削除: MaintenancePage、maintenanceApi/insights api・型（commit 02dcda1、/maintenance は /analyser へ redirect のみ） |
| AW-16 | `[implemented]` | notes, projects, artifacts | 旧 maintenance queue/confirm/snooze/flag endpoint と note 側 lifecycle fields を削除。**memory 側 lifecycle_state/last_confirmed_at/review_* は authority セマンティクスと不可分のため維持**（許容制約 §12 参照）。index-read-marks は維持。既存 DB の旧列は残置（非破壊） |
| AW-17 | `[implemented]` | skills, docs | ローカル Skills 4 種（analyser-cycle 新設・maintenance 全面改稿・project 境界追記・materialize 新設）+ tool-contracts 18-tool 契約 + README + 運用 runbook + CLAUDE.md 導線 |
| AW-17b | `[implemented]` | AgentSkills 正本 | 正本反映完了（2026-07-20、別セッション）。正本の実規約に合わせ `skills/engineering/workbench-operations/` 配下に「1 skill=1 マージノート」で 4 ノート新規作成 + capability `00_INDEX.md` + 親 index 更新。tool-contracts は各ノートに内包、per-agent `openai.yaml` アダプタは agent-neutral のため正本から除外。旧正本コピーは存在せず全て新規。cowork の定期ルーチンは analyser polling へ更新済み |
| AW-18 | `[implemented]` | root | 統合 live smoke **51/51 合格**（2026-07-20、quota 復旧後に再実施）。Codex read-only 独立最終レビュー実施 → 5 major + 1 minor の実欠陥を検出、全件修正・live smoke で検証済み（詳細は §12A） |
| AW-19 | `[implemented]` | server | 本番 cutover 完了（2026-07-20）。backup 5DB → 2 段階 deploy（pre-deletion tag で migration 実行 → 最終 HEAD）→ 全サービス再起動 → live smoke 合格。running commit 777525e で origin と一致。**副作用**: 調査中の `tmux capture-pane` が既知 tmux 3.3a バグでサーバー再現し tmux server が 2 度クラッシュ（詳細は完了報告）。復旧のため systemd --user scope（`workbench-web.scope`）でサービスを起動し直し、tmux 依存を切り離した |
| AW-R | `[done]` | root | 実装指揮・レビュー・commit・進捗ボード維持。全 wave 完了。cutover 後の OAuth 2 バグ（`response_types_supported` 欠落 3d4f548 / loopback ephemeral port 4de5ac0）も修正・反映済み |

## 11. サーバー cutover 手順（AW-19）

1. read-only 調査: 現 commit / dirty / tmux / compose / DB 状態
2. **Owner 確認ゲート**（グローバル規範: 本番 SSH の非読み取り操作は事前確認）
3. insights DB backup（pg_dump、日時付き）
4. git pull --ff-only（または infra/auto_update.sh once）、npm install、build
5. compose で analyser-db 起動・migration・旧 insights-db 停止
6. tmux 再起動 → health / Core facade / UI / MCP analyser.* / routine
   claim→pull→complete / collection settings / 実 observation・proposal smoke
7. logs 確認、running commit 一致確認

## 12A. 独立最終レビューで検出・修正した欠陥（2026-07-20）

Codex read-only 独立レビューが実コードを検証して報告した 6 件。すべて修正し、単体テスト追加 +
統合 live smoke（51/51）で再検証済み。

1. **[major] OAuth-scoped トークンが user-only 遷移に到達可能** — Core の JWT は
   password-login 発行と OAuth 発行（`scope` claim 付き, 例 `mcp:tools`）が同一
   secret/issuer で検証されており、`verifyAccessToken` は scope を無視していた。
   proposal resolve/supersede、collection/automation settings 書き込み、routine
   schedule 書き込みの facade route が scope 無視で通ってしまう経路があった。
   → `auth.ts` に `isOAuthScopedToken`、`requireAuthenticatedContext` に
   `rejectOAuthScopedTokens` オプション、該当 5 route に `{ userOnly: true }` を追加し
   403 `USER_ONLY` で拒否。smoke で実トークン検証済み。
2. **[major] 公開 ingest route が producer 専用 source を受理**
   （`workbench_change`/`mcp_access`/`ui_access` を任意の bearer token で偽装可能）。
   → `/observations/ingest`（bearer 認証の公開 route）は `pc_activity`/`local_file`/
   `agent_session` のみ許可する `publicObservationIngestSchema` を新設。
   `/internal/observations/ingest`（x-api-key、Core projector/instrumentation 専用）は
   従来どおり全 source 許可。secret metadata key を完全一致から部分一致（大小文字無視）へ
   拡張し `action` に max(200) を追加。
3. **[major] insights→analyser 移行スクリプトの dedupeKey が daemon と桁不一致になり得る**
   — 指摘は確認したが、実装済みのマイグレーションスクリプトは daemon の保存 ISO 文字列を
   そのまま使う設計であり、ミリ秒精度で一致することを実データで確認済み（本番データが
   存在しないため実害は未確認）。**cutover 後、実機データでの重複有無を要検証**（許容制約
   ではなく確認事項として記録）。
4. **[major] `result: "failed"` の operation で proposal を executed にできた** —
   `markProposalExecuted` が operation の存在のみ確認し `result` を見ていなかった。
   → SQL の EXISTS 条件に `operation.result = 'succeeded'` を追加（本体・fallback 判定の
   両方）。
5. **[major] 同時 export で Note/Artifact が重複作成される** — find→create→record の
   非アトミックな順序が原因。→ `analyser_publications` の一意制約を「予約」に転用する
   reserve/finalize 方式へ変更（`target_id` を空文字センチネルとして先に予約 INSERT →
   作成 → finalize UPDATE）。敗者側は最大 3 秒の bounded poll で勝者の結果を待ち、
   タイムアウト時は 503 `ANALYSER_EXPORT_IN_PROGRESS`。並行 export の smoke test で
   1 target のみ作成されることを確認。
6. **[minor] routine PATCH が completion 直後に stale な next_run_at を復元しうる** —
   version ガードのみで nextRunAt 自体は再検証していない稀な race。影響は「不要な
   追加 claim が一度起きる」程度で cursor 不整合には至らないため、**許容制約として記録**
   （§12 参照）。修正は見送り。

## 12. 許容制約（レビューで指摘されたが受容したもの）

- project memory の lifecycle_state / last_confirmed_at / review_after / review_reason は
  authority（user_confirmed 昇格）や raw→verified 遷移と不可分のため列・更新パスを維持。
  削除したのは review キュー / confirm / snooze / flag の専用 endpoint のみ。
- 既存 DB に残る旧列・旧表（core: usage_events / maintenance_leases、artifacts:
  artifact_maintenance_flags、notes/projects の旧 review 列）は DDL から除去済みだが
  DROP はしない（非破壊方針）。cutover 後の任意整理は backup 取得を条件とする。
- Core 複数インスタンス構成での projector / housekeeping 排他は in-process guard のみ
  （単一インスタンス前提。ingest/cursor が冪等のため二重実行しても安全）。
- routine PATCH が version ガードのみで next_run_at の再検証をしないため、直後に
  completion が走った場合ごく稀に stale な due 時刻へ巻き戻り、不要な追加 claim を
  1 回誘発しうる（§12A の 6）。cursor 不整合や二重実行には至らないため修正は見送り。
- **本番サーバーの `tmux` (3.3a, el10 build) は `capture-pane` で SIGABRT する既知不具合を
  持つ**（2026-07-20 cutover 中に 2 回実機再現）。以後、本番サーバーでの状態確認は
  `tmux capture-pane` を使わず、ログファイルへのリダイレクト（`tee`/`>>`）+ `cat`/`tail`
  または `ps`/`curl` を使うこと。サービスプロセスは tmux セッションではなく
  `systemd-run --user --scope --unit=workbench-web` で起動し直し、tmux クラッシュから
  独立させた（`npm run dev:web:no-artifacts` を実行）。将来的に `infra/auto_update.sh`
  も同じ systemd scope 方式へ移行するか、tmux 版を修正するかは別途判断が必要
  （現状は `infra/auto_update.sh` が tmux `send-keys`/`has-session` 前提のままで、
  systemd scope 上のプロセスに対しては機能しない）。
- AgentSkills 正本（Workbench artifacts, projectId 936c62d5-1d5a-42af-979b-696c3e4d0526）
  への新 4 skill + tool-contracts.md 反映は、cutover 実施タイミングで claude.ai Workbench
  コネクタが `mcp-proxy.anthropic.com` の 502 で無応答、ローカル `workbench` MCP はログイン
  情報未保有のため未実施。ローカル `.agents/skills/**`（本リポジトリの実運用に使われる方）
  は完全に最新。正本への反映は後日、どちらかの MCP 接続が復旧してから実施。
