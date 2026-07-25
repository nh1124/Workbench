# LBS Consolidation Proposal

Last updated: 2026-07-13
Status: proposal (decision pending user approval)

## 1. 背景と問題意識

LBS（Load Balancing System）は独立プロジェクトとして開発され、現在は `services/lbs`（FastAPI + SQLAlchemy, コア約1,400行）としてモノレポに同居している。Workbench の Tasks 機能は `services/tasks`（TypeScript）が LBS の HTTP API を叩くアダプタ構造になっており、タスク定義・繰り返し・例外・実行履歴・負荷計算は LBS 側、Today/schedule item・subtask・attachment・pin は tasks 側 Postgres という二重管理になっている。

## 2. 境界コストの実証（2026-07-13 デバッグセッションの所見）

このセッションで確認された高優先度バグは、subtask の occurrence 分離を除きすべて **tasks ⇔ LBS 境界の産物**だった:

| バグ | 境界起因の理由 |
|---|---|
| occurrence move が部分失敗で永久 SKIP | HTTP 2 リクエストにトランザクションがない（補償処理で緩和済み、根治は同一 DB 化） |
| Today/Calendar の LBS 呼び出しが 2N〜3N 回 | 定義と状態が別サービスにあるための N+1（バッチ化で緩和済み） |
| LBS エラーの 404 誤分類・握り潰し | HTTP 境界のエラー変換層の欠陥（未修正・残課題） |
| 曜日境界（内部 Sun=0 vs LBS Sun=7）の変換漏れ履歴 | 表現の異なる 2 実装の同期義務 |
| recurrence 展開ロジックの TS/Python 二重実装 | `taskRecurrenceUtils.ts` が LBS のロジックを鏡写しに保守 |

`docs/imple/task-occurrence-stabilization-plan.md` の凍結契約（LBS を置き換えない）は安定化パスの前提であり、恒久方針ではない。安定化が完了した今、境界そのものを再検討するタイミングとして妥当。

## 3. 選択肢

### 案A: 現状維持＋境界強化
LBS を内部サービスとして残し、エラー分類の構造化・冪等化・バッチ API 追加で境界を固める。
- 利点: 移植リスクゼロ。LBS 単体 UI / Python クライアントがそのまま生きる。
- 欠点: 二重実装（recurrence・曜日・status 解決）の同期義務が永続。2 言語 2 DB の運用コスト。トランザクション不能は本質的に解決しない。

### 案B: 一括統合（フルポート）
LBS のドメイン全体（定義・繰り返し・例外・履歴・負荷エンジン）を `services/tasks` の TypeScript + Postgres に移植し、LBS を引退させる。
- 利点: 境界消滅。単一 DB でトランザクション可能。スタック統一。
- 欠点: 一括移行はリスクが大きい（特に `lbs_engine.py` の負荷計算・ペナルティの挙動再現）。移行中に機能停止の危険。

### 案C: 段階統合（推奨）
**Phase 1 — データモデルの吸収**: タスク定義・繰り返しルール・例外・実行履歴を tasks サービスの Postgres に移す。recurrence 展開は既存の `taskRecurrenceUtils.ts` を正本に昇格（LBS 互換の weekday_mon1 変換は CSV 境界のみに縮退）。occurrence complete/move/skip が同一 DB トランザクションになり、補償処理が不要になる。
**Phase 2 — 負荷エンジンの移植**: `lbs_engine.py`（327行）を TS に移植。新旧で同一入力→同一出力を検証するゴールデンテストを先に作り、移植後に並走比較する。`tasks_lbs_calculate` / `heatmap` / `trends` / `dashboard` / `conditions` の MCP ツール契約は変えず内部実装だけ差し替える。
**Phase 3 — LBS 引退**: LBS 単体 UI・auth・API キー管理を停止し、リポジトリをアーカイブ。CSV import/export は互換維持（移行ツールとしても機能）。

- 利点: 各フェーズが独立してリリース可能・ロールバック可能。最大の資産（負荷エンジン）はゴールデンテストで守る。バグの主因（データ境界）を Phase 1 で先に潰せる。
- 欠点: 移行期間中は新旧併存の複雑さがある（二重書き込み or 一括データ移行の選択が必要）。

## 4. 推奨: 案C（段階統合）

理由:
1. 今回のバグ群が示す通り、維持コストの主因は「データの所有権が分かれていること」であり、Phase 1 だけで大半が解消する。
2. LBS の本質的価値は負荷計算エンジンであり、CRUD 部分は既に tasks 側で半分再実装済み（重複の解消は削減であって新規開発ではない）。
3. LBS 単体利用の実態が Workbench 経由に一本化されているなら、独立プロジェクトとして維持する理由は薄い。

## 5. 実務メモ

- データ移行: LBS の DB（PostgreSQL / 開発時 lbs.db）から tasks Postgres へ。CSV export → import 経路が既にあるため、初回移行ツールとして流用可能。
- 互換面: `tasks_lbs_*` MCP ツールと Core facade のルート形状は凍結し、内部実装のみ差し替え。sync-daemon Local Mode は既に TS recurrence を使っており影響は小さい。
- ゴールデンテスト: 実データ（現行 LBS の全タスク＋履歴）でスケジュール展開・負荷計算の新旧出力を比較するスクリプトを Phase 2 の受け入れ条件にする。
- 認証: LBS トークンのプロビジョニング（`ensureLbsAccessToken`）が丸ごと不要になり、認証は JWT / internal x-api-key に一本化される。

## 6. 未決事項（ユーザー判断待ち）

1. LBS を単体プロダクトとして今後も使う予定があるか（あるなら案A寄りの判断もあり得る）。
2. Phase 1 の移行方式: 一括データ移行（推奨・シンプル）か、二重書き込み期間を設けるか。
3. 着手時期と、既存の stabilization plan の凍結契約の正式解除。
