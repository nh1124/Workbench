# Workbench Analyser / Capture v2 Plan (2026-07)

Status: `[in-progress]` — 2026-07-10 Owner承認済み(名称=Analyser / autoPublish既定OFF / スクリーンショット採用)
Last updated: 2026-07-10

背景: 2026-07-10 のOwner所感5件。capture導入によりMaintenanceページの性格が
「知識レビュー」+「作業ログ閲覧」の複合へ変わったことが根本原因のため、
単発修正ではなく一貫した再設計として扱う。
Status legend は maintenance-loop-plan §1 と同一。状態更新は root のみ。

## 所感と対応方針の対応表

| # | 所感 | 対応 |
|---|---|---|
| 1 | MaintenanceはPROJECTでなくTOOL分類 | AN-1: navをTOOLセクションへ移動 |
| 2 | Log/Work Analyserのような名称が良い | AN-1: ページを「Analyser」へ改称し、Review / Activity の2タブ構成に(下記補足) |
| 3 | Local SyncはServicesの一種。大画面でServicesレイアウト崩れ | AN-2: ServicesへLocal Syncカード統合 + グリッド修正 |
| 4 | スクリーンショット等、capture解析の強化 | CV2-2(解析強化・安全な範囲) + CV2-3(スクリーンショット、別契約・要承認) |
| 5 | note自動保存でなく独立保存 + 必要時にartifact/noteへ | CV2-1: capture独立保存 + 明示エクスポート |

補足(#2): 現行ページの中身は「メンテナンスキュー(知識レビュー)」であり、
ログ解析そのものではない。名称だけ Log Analyser にすると機能と乖離するため、
**ページを2タブに分割**して両方の性格を明示する:
- **Review** タブ = 現行キュー(confirm / snooze / flag / supersede)
- **Activity** タブ = 作業ログ(capture日次サマリの閲覧、usage計測の要約)
これにより「Work Analyserらしさ」はActivityタブが担い、知識レビューの機能名も歪まない。

## 決定事項(案)

```text
AC-D1 ナビゲーションと名称(#1, #2)
- サイドバーの「Maintenance」をPROJECTセクションからTOOLセクションへ移動。
- ページ名を「Analyser」へ改称し、Review / Activity の2タブ構成にする。
  ルートは /analyser(旧 /maintenance はリダイレクト維持)。
- 名称は §決定が必要な事項(1) でOwnerが最終決定する。

AC-D2 Services整理(#3)
- Settings > Local Sync の内容を Services ページのカード「Local Sync」として統合
  (カードのConfigureから現行の設定UIへ。Tauri検出時はCaptureセクションも同カード配下)。
  Settings側の旧セクションは当面残し、Servicesからの導線を正とする(段階移行)。
- Servicesのグリッド崩れ修正: カードを固定最小幅のresponsive grid
  (grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)))へ統一し、
  カード高さを揃える。大画面(>1600px)での挙動を受入に含める。

AC-D3 capture独立保存と明示エクスポート(#5) — CC-D5の改訂
- capture_summaries へ summary_markdown TEXT を追加し、日次サマリ本文を
  capture.sqlite に正本として保存する。
- noteへの自動投入は設定 captureAutoPublish(default OFF)へ変更する。
  ONの場合のみ従来どおり default project へ raw note を投入。
- daemon loopback へ追加:
  GET /capture/summaries?limit=&cursor=      (日付降順の一覧)
  GET /capture/summaries/:date               (本文)
  POST /capture/summaries/:date/publish      body: { target: "note" } → 既存の
    outbox経由 note 投入(raw + tag workbench-capture)。既存publish経路を再利用。
- UI(Activityタブ): 日別サマリの閲覧 + 「Save to Notes」ボタン(上記publish)。
  Artifactへの保存は「Save to Notes」で作ったnoteを既存機能で移動/リンクできるため
  初期版では作らない(必要なら後続)。
- メンテナンスループへの影響: 自動投入OFFが既定になるため、captureの知識化は
  「人がActivityタブで見て保存する」明示操作に変わる。保存されたnoteは従来どおり
  raw でキューに載る(ループ接続は明示投入時のみ)。

AC-D4 解析強化・安全な範囲(#4前半) — summary v2
- サンプルを連続区間(同一アプリ+タイトルの連なり)へセッション化し、
  日次サマリへ追加: 集中ブロック(15分以上の連続区間)一覧 / context switch回数 /
  時間帯別の主要アプリ。
- idle検知: GetLastInputInfo(最終入力からの経過秒)をsamplerへ追加し、
  idle(例: 5分無入力)中のsampleを active時間から除外する。
  ※キー内容は一切取得しない(最終入力時刻のみ)。CC-D8の境界内。
- アプリ分類: 設定可能な process名→カテゴリ map(例: msedge→Browser,
  Code→Editor)。サマリにカテゴリ別合計を追加。既定mapは最小限。

AC-D5 スクリーンショット(#4後半) — 別契約・Owner承認必須
- 実装する場合の境界(CC-D8の拡張):
  - opt-in(capture本体と独立したトグル)、低頻度(既定5分、設定可)。
  - 保存はローカルのみ(capture dir配下、機外送信なし、outbox/API非経由)。
  - rolling削除(既定7日)。除外パターン一致中のウィンドウでは撮影しない。
  - 閲覧はActivityタブ(daemon loopback経由、Tauriのみ)。
  - OCR・vision解析は行わない(将来必要ならさらに別契約)。
- 撮影はWindows: PowerShell + System.Drawing(CopyFromScreen)で全画面PNG。
- 採否を §決定が必要な事項(3) でOwnerが決定する。未承認なら [deferred]。
```

## Owner決定(2026-07-10)

1. **名称**: A案「Analyser」を採用。タブ名は Review / Activity。
2. **captureAutoPublish 既定OFF**: 承認。文字化けした既存note/サンプルの削除は受入時に実施。
3. **スクリーンショット(AC-D5)**: 採用。CC-D8拡張の境界(ローカルのみ・opt-in・
   rolling削除・除外パターン尊重・OCRなし)を厳守する。

> **AC-D6 は置き換え済み(2026-07-10)**: Ownerのcapture本来構想(複数PC集約 +
> エージェント定期分析)により抽出トリガー(a)(b)が要件化されたため、
> [workbench-insights-service-plan.md](archive/workbench-insights-service-plan.md) を正本とする。
> maintenance/analyser の Review 側を domain 残留とする判断は不変。

```text
AC-D6 サービス構成(Owner相談への回答、2026-07-10決定)
- maintenance/analyserは独立microserviceに**しない**(現時点)。
  理由: queue reasonの導出とconfirm/snooze mutationはdomain行の属性であり
  projects/notesから移せない。分離しても「Coreと同役の集約層がもう1 hop増える」
  だけで管理は楽にならない。Core内実装は maintenanceQueue / maintenanceActions /
  usageEventsStore / syncChanges のmodule群に分離済みで、継ぎ目は確保されている。
- 抽出条件(いずれか実証された時点で "insights service" として切り出す):
  (a) 複数マシンからのcapture/計測ingestが必要になる
  (b) 分析が独自の永続状態・スケジューラを要するほど重くなる
  (c) Core肥大が実測で問題化する
```

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| AN-1 | `[implemented]` | ui | nav移動(TOOL) + 「Analyser」改称 + Review/Activityタブ構成 + /maintenanceリダイレクト (commit 739536f) |
| AN-2 | `[implemented]` | ui | ServicesへLocal Syncカード統合 + グリッドレイアウト修正(大画面) (commit 739536f) |
| CV2-1 | `[implemented]` | daemon/ui | daemon側 aace73c(summary_markdown保存 + autoPublish default OFF + summaries list/get/publish API)、UI側 739536f(Activityタブ閲覧/Save to Notes)。build + 22 files/114 tests pass |
| CV2-2 | `[implemented]` | daemon | セッション化/集中ブロック/context switch/idle検知/カテゴリ分類のsummary v2 + metrics_json保存 (commit 791a5bc, 112 tests pass) |
| CV2-3 | `[implemented]` | daemon/ui | スクリーンショット(AC-D5): daemon 456402a(撮影/除外スキップ/rolling削除/loopback API、116 tests) + UI 5f6a29e(Activityタブviewer + 設定、build/116 tests pass) |
| ACV-R | `[in-progress]` | root | 実装指揮・レビュー・検証・commit完了。残: Owner受入(§受入 1〜5) |

## 受入(実装後)

1. サイドバーのTOOL配下に Analyser があり、Review タブに現行キュー、
   Activity タブに日別captureサマリが表示される。/maintenance は転送される。
2. Services に Local Sync カードがあり、大画面でカードが等幅・整列で崩れない。
3. capture有効時、noteは自動生成されず、Activityタブから Save to Notes した
   もののみ default project に raw note として現れ、Review キューに載る。
4. summary v2 に集中ブロック・context switch回数・カテゴリ別合計が含まれ、
   idle時間がactive時間から除外される。
5. (CV2-3採用時) スクリーンショットがローカルのみに保存・閲覧でき、
   除外パターン中は撮影されない。
