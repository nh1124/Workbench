# Workbench Capture Client Implementation Plan

Status: 実装完了(2026-07-07、commits 71da5d8, c3d029e, 844a5cb)。残: §4受入(Owner実機確認)。sidecar同梱はrewrite追加+埋め込みfallbackで対応済み(2026-07-07 hotfix)
Last updated: 2026-07-07

関連: [workbench-maintenance-loop-plan.md](workbench-maintenance-loop-plan.md) D-108 / §9
(実装形態の決定経緯はそちらを正とする)

目的: PC操作の常時captureを sync-daemon 内モジュールとして実装し、要約のみを
inbox(default project)へ `lifecycleState=raw` の note として投入する。
raw note は P1 のメンテナンスキューに自動的に載り、レビューUIで triage される
(= メンテナンスループへの取り込み口が閉じる)。

Status legend は maintenance-loop-plan §1 と同一。
**本文書の状態更新は root agent (Claude) のみが行う。**

## 1. Progress Dashboard

| Phase | 内容 | Scope | Status | 進捗 |
|---|---|---|---|---|
| C1 | sync push notes ops への lifecycle passthrough | core | `[implemented]` | 2/2 |
| C2 | capture基盤: 設定・専用DB・collector(子プロセス)監視 | sync-daemon | `[implemented]` | 4/4 |
| C3 | 日次summarizer + outbox投入 + retention + loopback API | sync-daemon | `[implemented]` | 5/5 |
| C4 | native Settings UI(Tauri専用) + daemon status連携 | ui/native | `[implemented]` | 3/3 |
| C5 | root検証・受入・commit | root | `[in-progress]` | 1/2 |

## 2. Contract Freeze

```text
CC-D1 配置と分離
- モジュールは services/sync-daemon/src/capture/** に閉じる。
- sync内部(manifestStore等)を直接importしない。outbox投入・設定読み込みは
  daemon本体から注入する狭いinterface経由とし、将来の同格client抽出を安価に保つ。

CC-D2 collector
- Windows: 常駐PowerShell子プロセス。user32 GetForegroundWindow +
  GetWindowText + プロセス名を pollingし、JSON lines を stdout へ出力する。
- polling間隔 default 15秒(設定可)。daemonが子プロセスを監視し、異常終了時は
  backoff付きで再起動する。collectorの停止がファイル同期へ影響しないこと。
- macOS / Linux は [deferred](フレームは共通、samplerのみOS別)。

CC-D3 生データ保存
- 専用SQLite: default `%LOCALAPPDATA%\Workbench\capture.sqlite`
  (env WORKBENCH_CAPTURE_DB_PATH で変更可)。
- sync root 配下・.workbench 配下のパスは拒否する(同期対象に生ログを置かない)。
- retention: default 14日。日次で期限切れsampleをrolling削除する。
- 生データ(sample行)は機外へ出さない。いかなるAPI/outboxにも載せない。

CC-D4 要約(rule-based、LLMなし)
- 日次サマリ: アプリ別合計アクティブ時間、上位ウィンドウタイトル(件数/時間)、
  1時間粒度のタイムライン。deterministicなmarkdown生成。

CC-D5 投入
- daemon outbox経由で default project へ note を投入する。
  title `Capture Daily Summary YYYY-MM-DD` / tag `workbench-capture` /
  lifecycleState=raw。
- 同日の再生成は同一noteを更新する(note idをcapture DBに記録して対応付け)。
- 前日分サマリは日付が変わった後の最初のtickで自動生成する
  (daemonは常駐であり、Coreへschedulerを足すわけではない)。

CC-D6 既定OFFと可視性
- captureは default OFF。有効化は loopback API / native Settings のみ。
- daemon /status に capture: { enabled, collectorAlive, lastSampleAt,
  lastSummaryAt, sampleCount24h } を含める。
- daemon MCPへは read-only の workbench.capture.status のみ追加する
  (start/stopはMCPへ露出しない)。

CC-D7 Core契約
- Coreへの新規routeは追加しない。唯一の変更は sync push の notes
  create/update/upsert op が lifecycleState / reviewAfter / tags を
  透過することを保証する additive な拡張のみ。

CC-D8 収集内容とプライバシー
- 収集はアプリ名(プロセス名) + ウィンドウタイトル + タイムスタンプのみ。
- キー入力・スクリーンショット・クリップボード・URL解析は行わない
  (採用する場合は別contract)。
- 除外設定: タイトル/プロセス名の正規表現リスト(設定可)。一致したsampleは
  保存自体を行わない。idle検知: 同一タイトルが続いても記録は間引かない
  (要約側で連続区間として集約)。
```

### 2.1 Daemon loopback API

```text
GET  /capture/status          → CC-D6のstatus + config要約
POST /capture/enable
POST /capture/disable
GET  /capture/config
PUT  /capture/config          body: { intervalSeconds?, retentionDays?,
                                      excludePatterns?: string[] }
POST /capture/summarize       body: { date? (YYYY-MM-DD, default 昨日) } → 手動生成
```

既存の loopback token (`WORKBENCH_DAEMON_API_TOKEN`) 適用対象。

### 2.2 capture.sqlite schema

```sql
CREATE TABLE IF NOT EXISTS capture_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at TEXT NOT NULL,          -- ISO
  process_name TEXT NOT NULL,
  window_title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_samples_time ON capture_samples(sampled_at);
CREATE TABLE IF NOT EXISTS capture_summaries (
  summary_date TEXT PRIMARY KEY,     -- YYYY-MM-DD
  note_resource_id TEXT,             -- 対応するWorkbench note id(判明後)
  generated_at TEXT NOT NULL,
  sample_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

## 3. Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| C1-1 | `[implemented]` | core | sync push notes create/update/upsert で lifecycleState/reviewAfter/tags を透過(additive)。lifecycleStateは raw/triaged のみ許可 |
| C1-2 | `[implemented]` | core | passthrough tests |
| C2-1 | `[implemented]` | daemon | capture config(env+loopback PUT、default OFF)。DBパスのsync root配下拒否 |
| C2-2 | `[implemented]` | daemon | capture.sqlite storage(§2.2) + 除外パターン適用 + retention削除 |
| C2-3 | `[implemented]` | daemon | Windows sampler script(常駐PS子プロセス、JSON lines) |
| C2-4 | `[implemented]` | daemon | collector supervisor(起動/停止/クラッシュ再起動/バックオフ)。sync本体と独立 |
| C3-1 | `[implemented]` | daemon | 日次summarizer(CC-D4のmarkdown、deterministic) |
| C3-2 | `[implemented]` | daemon | outbox投入interface(注入)経由の note create/update(CC-D5、raw+tag) |
| C3-3 | `[implemented]` | daemon | 自動生成tick(日付変化後の初回) + POST /capture/summarize |
| C3-4 | `[implemented]` | daemon | loopback API一式(§2.1) + /status拡張 + MCP workbench.capture.status |
| C3-5 | `[implemented]` | daemon | tests(config拒否パス、除外、retention、summarizer、供給互換) |
| C4-1 | `[implemented]` | ui | Settings > Sync Daemon 隣に Capture セクション(Tauri検出時のみ表示): enable/disable、interval、retention、除外、status表示 |
| C4-2 | `[implemented]` | ui | capture loopback API client + status polling |
| C4-3 | `[implemented]` | native | desktop-managed daemon起動時のcapture設定env注入(必要な場合のみ。原則loopback設定で完結) |
| C5-1 | `[implemented]` | root | レビュー・build/test検証・commit |
| C5-2 | `[in-progress]` | root | 受入(§4)。Ownerの実機確認待ち |

## 4. 受入シナリオ

1. 既定状態で daemon を起動しても capture は動かない(/statusで enabled=false、子プロセスなし)。
2. Settings(desktop)から有効化 → collectorAlive=true、sampleが溜まる。
3. `POST /capture/summarize` で当日分を手動生成 → default project に
   `Capture Daily Summary YYYY-MM-DD` の note(tag workbench-capture)が現れる。
4. その note が `/maintenance` キューに reason=raw で載る(ループ接続の確認)。
5. 同日をもう一度 summarize → 同一 note が更新され、重複しない。
6. 無効化 → 子プロセスが終了し、sampleが増えない。ファイル同期は全期間無影響。
7. `WORKBENCH_CAPTURE_DB_PATH` に sync root 配下を指定すると起動時に拒否される。
8. 除外パターンに一致するウィンドウが sample に現れない。

## 5. Deferred

- macOS / Linux sampler。
- LLMによる高次要約(現状はrule-based集計のみ)。
- capture専用scope token(同格client化するときに再検討)。
- URL・ドキュメントパス等のアプリ内詳細の収集(別contract)。
