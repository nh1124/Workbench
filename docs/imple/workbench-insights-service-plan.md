# Workbench Insights Service Plan (2026-07)

Status: `[approved]` — 2026-07-10 Owner承認(方向性 / 二層プライバシー / 分析主体)
Last updated: 2026-07-10

背景: captureの本来目的は「自分の作業を自動記録し、分析して発見・改善・提案につなげる」こと。
Owner構想は「各接続PCの作業を記録 → サーバ集約 → エージェントが定期分析・提案 →
必要時のみ artifact/note へ移す」。現状実装(capture v1/v2)はローカル記録+要約+明示エクスポート
までで、集約と分析の中核が未着手。analyser-capture-v2-plan の AC-D6 が挙げた抽出トリガー
(a) 複数マシンingest (b) 独自永続状態を要する分析 が本構想で要件化されたため、
insights service として切り出す。**本計画は AC-D6 を置き換える。**

Status legend は maintenance-loop-plan §1 と同一。状態更新は root のみ。

## Owner決定(2026-07-10)

1. **insights service として書き起こす**(本計画)。
2. **二層プライバシー**: メタデータ(アプリ名/タイトル/タイムスタンプ/idle)と日次サマリは
   自サーバへ集約可。スクリーンショット**画像そのものはローカルのみ**(機外送信なし)。
   ただし**ローカル操作可能なagentがスクリーンショットを処理・加工した派生データ**
   (テキスト化した要点等)を、明示操作でサーバへ追加集約することは可。
3. **分析主体は cowork/Codex ルーチン**(MCP経由)。特定LLM/agentに依存しない設計を軸とし、
   今後も変えない(恒久方針)。製品側は良質なクエリAPIの提供に徹し、製品内に
   スケジューラ/分析ジョブは持たない(maintenance-loop D-105 の踏襲)。

## 決定事項

```text
IS-D1 サービス新設
- services/insights を新設。own DB(PostgreSQL、他ドメインの表とjoinしない縦割り)。
- 外部窓口は従来どおり workbench-core 経由(gateway routing + internal x-api-key)。
  MCP tools は insights.* 名前空間。
- Core 側は routing とスキーマ検証のみ。集計ロジックは insights 内に置く。

IS-D2 データモデル(初期)
- machines(machine_id PK, display_name, platform, registered_at, last_seen_at)
- activity_samples(machine_id, sampled_at, process_name, window_title,
  idle boolean, PK(machine_id, sampled_at))
- activity_summaries(machine_id, summary_date, summary_markdown,
  metrics_json, updated_at, PK(machine_id, summary_date))
  ※metrics_json = capture summary v2 の構造化指標(セッション/集中ブロック/
    context switch/カテゴリ別合計)をそのまま格納。
- derived_observations(id, machine_id, observed_date, kind, title,
  content_markdown, payload_json, created_at)
  ※スクリーンショット等をローカルagentが加工した派生データの受け皿(IS-D3参照)。
- 分析の「結論」(発見・提案)はこのDBに持たない。エージェントが従来どおり
  projects memory / notes へ書く(知識はmaintenanceループに載る)。

IS-D3 プライバシー境界 CC-D8 v2(改訂)
- 不変: キー入力内容・クリップボードの取得禁止。excludePatterns 一致中は
  サンプル記録もスクリーンショット撮影もしない。
- 送信可(opt-in): activity_samples 相当のメタデータ、activity_summaries。
  daemon 設定 uploadEnabled(default OFF)で機単位に制御。
- 送信不可: スクリーンショット画像そのもの(ローカル保存・rolling削除のみ)。
- 例外: ローカルagentが画像を処理して生成したテキスト派生データは、
  明示的な ingest 操作(insights.derived.ingest)でのみサーバへ集約可。
  自動アップロードはしない。

IS-D4 daemon uploader(collector化)
- capture.sqlite はローカルバッファ兼一次正本として維持(オフライン耐性)。
- upload_cursor を保持し、samples/summaries を at-least-once でバッチpush
  (サーバ側は PK upsert で冪等)。失敗時は次tickで再送、ログはdedupe。
- machine_id は初回起動時に生成・登録(display_name は設定可)。
- 複数PC参加 = 各PCで daemon を動かし uploadEnabled を ON にするだけ。

IS-D5 クエリAPI / MCP tools
- insights.machines.list
- insights.activity.query(期間・machine・カテゴリでの集計/内訳)
- insights.summaries.list / insights.summaries.get(machine横断、日付降順)
- insights.derived.ingest / insights.derived.list
- 分析ルーチン(cowork/Codex)はこれらを読み、提案を projects_memory_append /
  notes へ書く。ルーチン用プロンプト/手順は skill 側に置く(製品外)。

IS-D6 UI(Activityタブのサーバ集約ビュー)
- 現行 Activity タブ(daemon loopback、ローカル1台)を基礎に、Core経由の
  insights API から machine 横断ビューを表示する(machineセレクタ + 日次サマリ)。
- Tauri 以外(ブラウザ)でも Activity タブが insights 経由で閲覧可能になる。
  ローカル専用機能(capture制御・スクリーンショット閲覧)は従来どおり Tauri のみ。
```

## 既存計画との関係

- analyser-capture-v2-plan の **AC-D6 は本計画で置き換え**(maintenance/analyser の
  Review側は引き続き domain 残留。切り出すのは活動データ系のみ)。
- CV2-2(summary v2 解析強化)は daemon 側で継続実装し、その構造化指標が
  IS-D2 の metrics_json / アップロード対象になる(先行して価値あり)。
- CV2-3(スクリーンショット)は「ローカルのみ」契約のまま変更なし。
  派生データ集約(IS-D3例外)は IS-5 で扱う。
- usage_events(Core DB)の insights への移設は本計画のスコープ外(後続検討)。

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| IS-1 | `[pending]` | services/insights, core | service scaffold + DB migration + ingest/query API + Core routing |
| IS-2 | `[pending]` | daemon | uploader(machine登録 / upload_cursor / at-least-once batch push / uploadEnabled設定) |
| IS-3 | `[pending]` | core | MCP tools insights.*(machines/activity/summaries/derived) |
| IS-4 | `[pending]` | ui, skill | Activityタブのmachine横断ビュー + 分析ルーチン手順のskill化 |
| IS-5 | `[pending]` | daemon, skill | スクリーンショット派生データの明示ingest導線(ローカルagent加工前提) |
| IS-R | `[pending]` | root | 実装指揮・レビュー・検証・commit・受入 |

前提順序: capture v2 の CV2-2 / CV2-3 完了後に着手(analyser-capture-v2-plan 参照)。

## 受入(実装後)

1. 2台以上のPC(または machine_id を変えた2 daemon)からの samples/summaries が
   サーバに集約され、insights.activity.query で machine 横断集計が返る。
2. uploadEnabled OFF の機からは一切送信されない。スクリーンショット画像は
   いかなる経路でもサーバへ送られない。
3. オフライン→復帰で欠損なく追いつく(at-least-once + 冪等upsert)。
4. cowork/Codex ルーチンが MCP のみで分析を完遂し、提案が memory/note に
   書かれ、Review キューに載る。
5. Activity タブで machine を切り替えて日次サマリを閲覧できる。
