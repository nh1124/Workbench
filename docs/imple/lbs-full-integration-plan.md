# LBS Full Integration Implementation Plan

Last updated: 2026-07-13
Decision: 一括統合（ユーザー承認済み 2026-07-13）。LBS のドメイン全体を `services/tasks`（TypeScript + Postgres）へ移植し、`services/lbs`（FastAPI）を引退させる。移行方式は一括データ移行（二重書き込みなし）。

## 1. Status legend

- `[pending]` / `[in-progress]` / `[review]` / `[approved]` / `[implemented]` / `[blocked]`

## 2. Objective

tasks ⇔ LBS の HTTP 境界を消滅させ、タスク定義・繰り返し・例外・実行履歴・daily condition・負荷エンジンを tasks サービス内に取り込む。外部契約（Core facade ルート、`tasks_lbs_*` MCP ツール、UI が叩く API 形状）は不変。

## 3. Non-goals

- Core facade / MCP ツールのルート・レスポンス形状の変更（内部実装のみ差し替え）。
- Tasks UI の再設計。
- LBS 単体 UI の移植（引退させる。LBS リポジトリはアーカイブとして残る）。
- lbs_daily_cache の移行（派生データ。純関数エンジンで都度計算し、性能問題が出た場合のみ後でキャッシュ層を追加）。

## 4. Reference semantics (contract)

**LBS Python 実装（`services/lbs/src`）が挙動の正本。** TS 側既存実装との既知の差分は LBS に合わせて修正する:

| 項目 | LBS (正) | 現行 TS (`taskRecurrenceUtils.ts`) |
|---|---|---|
| MONTHLY_DAY 月末 | `min(month_day, 月末日)` にクランプ | クランプなし（2/31 は永遠に発生しない） |
| MONTHLY_NTH_WEEKDAY nth=-1 | 月の最終該当曜日 | 未対応 |
| EVERY_N_DAYS anchor | `anchor_date` 必須（なければ発生しない） | activeFrom/createdAt へフォールバック |
| WEEKLY | mon..sun フラグ、フラグ全て false なら発生しない | フラグなし時 activeFrom/dueDate の曜日にフォールバック |
| ONCE + FORCE_DO/MANUAL_LOCK | due_date 以外の日にも例外で発生 | 未対応 |

注: TS 側フォールバック（WEEKLY/EVERY_N_DAYS）は Workbench 由来のデータ互換のため**保持**する（LBS に該当データが存在しないことを移行時に検証）。クランプ・nth=-1・ONCE 例外は LBS に合わせて追加。

例外タイプ: `SKIP` / `FORCE_DO` / `MANUAL_LOCK` / `OVERRIDE_LOAD` / `RESCHEDULE`（load override・時刻 override・is_locked を含む完全な優先順位は `lbs_engine.py:_process_day` / `_build_task_list` の通り）。

負荷モデル（`calculate_daily_load`）: `count_penalty = ALPHA * count^BETA`、`context_penalty = SWITCH_COST * max(contexts-1, 0)`、fatigue B+C model（load ×(1+0.2Fc)、cap ×(1-0.1Fc)）、level 閾値 0.6/0.8/1.0、overflow は SKIPPED 込みで判定。config は user 毎の `system_config`（ALPHA/BETA/SWITCH_COST/CAP）。

## 5. Test design（本計画の中核）

多数のバグが予想されるため、実装より先にテスト資産を作る。

### 5.1 Golden parity tests（新旧出力一致）

- `scripts/lbs-golden/capture.py`: Python LBS を fixture DB（`lbs.db` のコピー＋合成データ）に対してローカル起動し、以下のレスポンスを JSON で `services/tasks/src/lbs/__goldens__/` に保存する。
  - `GET /tasks`（active 両方）、`GET /tasks/{id}`、`GET /tasks/{id}/resolved?target_date=`
  - `GET /schedule?start&end`（複数ウィンドウ: 過去週・現在週・翌月・月末跨ぎ・年跨ぎ）
  - dashboard / heatmap / trends / context distribution / calculate（statuses フィルタ組合せ含む）
  - exceptions 一覧、history
- 合成 fixture には必ず含める: 全 rule_type、mon..sun 全パターン、月末クランプ（month_day=31 の 2 月）、nth=-1、全例外タイプ（override_load・時刻 override・is_locked）、fatigue 0..5、ONCE+FORCE_DO、SKIPPED 混在、複数 context、cap 超過日。
- TS 側 `goldenParity.test.ts`: 同じ fixture 入力から新エンジンで計算し golden と比較（float は 1e-9、日付は文字列一致）。**このテストが通ることを W2/W3 の受け入れ条件とする。**

### 5.2 Characterization tests（tasks サービス外形固定）

- 現行 tasks サービスの全ルートについて、LbsClient をモックした request→response 形状のスナップショットテストを swap **前に**追加・拡充する。swap 後も同一スイートが通ること（モックを local backend fixture に差し替え）。

### 5.3 Store/unit tests

- 新規テーブルの owner スコープ（全 mutation が owner 条件を含むことの監査テスト。既存 `coreMutationGuardAudit.test.ts` の方式を踏襲）。
- 例外優先順位・実行履歴の unique 制約（user+task+date upsert）・conditions 0-5 clamp。
- occurrence complete/move/skip が単一トランザクションであること（move の補償コードの削除とセットで）。

### 5.4 Migration tests

- fixture LBS DB → 移行 CLI → tasks DB の行数・ID・status・日付の完全一致検証。冪等性（2 回実行で重複なし）。dry-run モード。
- user マッピング（LBS user_id ↔ core owner）の欠損検出（マップ不能な行は報告して中断）。

### 5.5 Integration / E2E

- `npm test --workspace services/tasks` / `ui` / `services/sync-daemon` / `services/workbench-core` 全緑。
- `npm run test:e2e:api`（local backend で）。
- 手動シナリオ: stabilization plan §13 の 7 項目を local backend で再実施。

## 6. Architecture decisions

1. **`LocalLbsBackend`**: `LbsClient` と同一メソッド面（tasks/exceptions/schedule/dashboard/heatmap/trends/distribution/calculate/history/complete/CSV）を in-process 実装するクラスを `services/tasks/src/lbs/` に置く。呼び出し側（store.ts / taskScheduleStore.ts / taskExceptionStore.ts / lbsTaskService.ts）は client 生成箇所のみ変更。auth 系メソッド（login/provision/api-keys）は local では不要になり削除。
2. **切替フラグ**: `TASKS_LBS_MODE=remote|local`（default: remote）。移行検証完了後に local を default 化 → remote コード削除。ロールバック手段として移行期間中のみ残す。
3. **新テーブル**（tasks DB）: `task_definitions` / `task_rule_exceptions` / `task_executions` / `daily_conditions` / `lbs_user_config`。owner は既存の `owner_username` 規約に従う。task_id は LBS の String ID をそのまま移行（外部参照・subtask/attachment/schedule_item の task_id と互換）。
4. **エンジン**: `services/tasks/src/lbs/engine.ts` に純関数として移植（`calculateSchedule` / `calculateDailyLoad` / overflow / weekly stats / trends / distribution）。`taskRecurrenceUtils.ts` は engine のルール評価を再エクスポートする形に統合し、二重実装を解消（§4 のフォールバック互換は維持）。
5. **auth**: `ensureLbsAccessToken` / `provisionLbsAccount` / LBS トークン列は local モードでは不要。cutover 後に削除。
6. **prod 移行**: 移行 CLI は dry-run 必須。本番（rocky サーバ）での実行は必ずユーザー確認を取ってから（CLAUDE.md 規約）。

## 7. Workstreams & progress board

| ID | Status | Owner | Task | 受け入れ条件 |
|---|---|---|---|---|
| W0 | `[implemented]` | codex | Golden capture harness + 合成 fixture + goldens 生成 | 46 goldens・11 coverage checks 緑（commit 6484eba） |
| W1 | `[implemented]` | codex | 新テーブル schema + stores（owner スコープ・監査テスト） | 83 tests 緑（commit 4fcb030）。注: live Postgres 未検証（W7 で実施） |
| W2 | `[implemented]` | codex | engine.ts 移植 + golden parity | 46/46 golden 一致（commit 77d510b; fixture 入力エクスポートは 90c3157） |
| W3 | `[implemented]` | codex | LocalLbsBackend + TASKS_LBS_MODE 配線 + characterization swap | 46/46 golden 経由一致・137 tests 緑（commits de2e19a, debd8e3）。todo-complete は Python 同様「実行行削除」に修正済み |
| W4 | `[implemented]` | codex | 移行 CLI（dry-run/冪等/ユーザーマップ検証） | test_migrate 緑・dev lbs.db dry-run 成功（データは空; commit 6111420）。実データ移行は prod で W7 時に実施 |
| W5 | `[implemented]` | codex | recurrence 二重実装統合（taskRecurrenceUtils→engine 委譲、UI 側も同期） | 月末クランプ・nth=-1 採用、Workbench フォールバック保持（commit 186245b） |
| W6 | `[implemented]` | codex | local default 化・remote/provisioning コード削除・services/lbs 完全削除 | tasks 138 / core 93 / sync-daemon 120 緑（commit 9987962）。migrate CLI は standalone 化済み |
| W7 | `[implemented]` | root | dev 移行完了（lbs.db→tasks Postgres, verify 済）。**prod は移行不要と判明（2026-07-26 実地調査）** — レガシーデータは既に本番 tasks DB に存在済み。移行 CLI の実行は**データ破壊になるため実施しない**。根拠は §7.1 | dev: 済 / prod: 実行不要（調査により確定） |

### 7.1 W7 prod 調査結果（2026-07-26）

本計画書には長らく「prod 移行が未実施」と記録されていたが、**この記述は誤りだった**。本番（rocky）を
read-only で調査した結果、移行 CLI を実行してはならないことが確定した。

**調査事実**

| 項目 | 結果 |
|---|---|
| 本番デプロイ commit | `8ae1585`。W6 (`9987962`, 2026-07-13) を**含む**（`git merge-base --is-ancestor` で確認） |
| `lbs-backend` コンテナ | `Exited (137) 2 months ago`。レガシー LBS は 2 ヶ月前から停止 |
| レガシー `services/lbs/lbs.db` | 残存（348 KB, mtime 2026-07-13）。書き込み主体は存在しない |
| ソース行数 | tasks 167 / task_executions 17 / task_exceptions 3 / daily_conditions 0 / system_config 0 |
| ソース利用者 | 実データは 1 名のみ（`wb_a98b1d2d…@workbench.local` = 本番 core user `a98b1d2d7bb23d860f9f2f71547c29ce`）。dev-fallback ユーザは 0 行 |
| ターゲット行数 | task_definitions **241** / task_executions **141** / task_rule_exceptions 5 |
| task_id 突合 | ソース 167 件は**全て**ターゲットに存在（source-only = **0**）。ターゲット固有が 74 件 |
| `updated_at` 比較 | ターゲットの方が新しい: **108 件** / ソースの方が新しい: **0 件** / 同一: 59 件 |

**結論**: レガシーデータは既に本番 tasks DB に取り込まれており（最古 `created_at` がソース先頭行と完全一致）、
W6 デプロイ後の 13 日間で利用者が継続的に更新している。移行 CLI は `(owner_username, task_id)` で upsert
するため、いま実行すると**現行の 108 件を 2 ヶ月前の値で上書きする**。ソース側が新しい行は 1 件も無いため、
実行して得られるものは何も無く、失うものだけがある。よって **W7 は「実行不要」として完了**とする。

**残作業（任意・要ユーザー判断）**
- 本番の `~/Workbench/services/lbs/`（`lbs.db` 含む）はリポジトリから削除済みのサービスの残骸。
  ロールバック猶予は既に経過しているが、削除は本番書き込みのため未実施。バックアップ後に削除するか、
  このまま保全するかはユーザー判断。
- 別件（本計画とは無関係）: `workbench-tasks-db` が `0.0.0.0:5545` で listen している。外部からは
  クラウド FW で遮断されている（接続がタイムアウト）が、FW 設定変更時に Postgres が露出する。
  `127.0.0.1:5545` へのバインド変更を推奨。

レビュー方針: 各 workstream は codex 実装 → root（Claude）が差分レビュー・検証・commit。W2 の golden 不一致は「golden が正」を原則とし、LBS 側バグと判断した場合のみ理由を本計画書に記録して例外とする。

## 8. Verification commands

```powershell
npm test --workspace services/tasks
npm test --workspace ui -- taskRecurrenceUtils taskTodayRows taskOccurrenceStatusMutation
npm test --workspace services/sync-daemon
npm test --workspace services/workbench-core
npm run build --workspace services/tasks; npm run build --workspace ui
npm run test:e2e:api
```
