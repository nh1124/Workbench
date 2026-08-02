# Workbench Native: 常駐の主体を daemon へ移す（役割の反転）

トレイに常駐しグローバルショートカットを受け付ける主体を、main アプリから **sync-daemon** へ移す。
アプリは daemon に出入りするクライアントになる。

**着手条件: variant 分割（[workbench-native-variant-apps-plan.md](workbench-native-variant-apps-plan.md)）の完了後。**
2026-08-02 にユーザー指摘で判明した食い違いを、独立した改修として切り出したもの。

## 想定アーキテクチャ

- **daemon が常駐**し、グローバルショートカットを受け付ける
- daemon が必要に応じて **main を起動**する、task を読む
- アプリが起動している間は daemon も必ず起動（アプリ連携のため）
- アプリが落ちている間も、ユーザーが望まない限り常駐（`exitWhenIdle` = off）

つまり **daemon = 常駐サービス、アプリ = 出入りするクライアント**。

## 現状（逆になっている）

| | 想定 | 現状 |
|---|---|---|
| トレイ常駐 | daemon | main |
| グローバルショートカット | daemon | main（`shortcuts::register`） |
| main の起動 | daemon が必要に応じて | ユーザーが直接 |
| daemon の寿命 | 自律 | main が握っていた |

variant 計画の Phase 4（参照カウンタ）で「main が daemon を殺す」までは解消済み。
**役割の反転そのものは手つかず**。

## この食い違いが実際に生んだ判断

`exitWhenIdle`（アプリが使っていないとき daemon を止める設定）の「使用中」の定義で 2 案が出た。

- **(a) ウィンドウを持たない常駐アプリはリースを手放す** — 「使用中 = ウィンドウが開いている」
- **(b) プロセスが生きていれば使用中** — 「使用中 = アプリが起動している」

**想定アーキテクチャ上は (a) が正しい。** しかし役割が反転していない現状で (a) を入れると、
main がトレイへ退いた瞬間にリースを手放し、**「main は生きているのに daemon が落ちる」**という
避けたい挙動をわざわざ作り込むことになる。

したがって variant 計画では **暫定的に (b)** を採用した（現在の実装がそのまま該当）。
`exitWhenIdle` は「トレイからも含めて Workbench を完全終了したときに daemon も止める」設定として
意味を持ち、UI 文言もそう書いてある。

**本改修が完了した時点で (a) を再検討すること。** これが本計画の主要な下流影響。

## 移す必要があるもの

| 対象 | 現在地 | 備考 |
|---|---|---|
| グローバルショートカット登録 | `shortcuts::register`（main の `setup()`） | daemon 側へ |
| トレイアイコンとメニュー | `initialize_tray_icon`（main 限定） | daemon 側へ |
| main の起動経路 | 無し（ユーザーが直接起動） | daemon から exe を spawn する口が要る |
| `residentMode`（close→hide） | main | 不要になる。main は普通に終了してよい |
| daemon 停止時の後始末 | — | トレイが消えるので、復帰導線の設計が要る |

## 最大の論点: daemon の実装言語

daemon は現在 **Node の sidecar**（`services/sync-daemon`、Tauri の `externalBin` として同梱）。
そこに Windows のトレイ UI とグローバルショートカットを持たせるのは相応の追加依存になる。

選択肢:

- **(1) Node のまま**、トレイ／ショートカット用のネイティブアドオンを足す。依存が重く、
  クロスプラットフォーム性も怪しい
- **(2) 二層構成にする** — 常駐部（トレイ・ショートカット・プロセス管理）を Rust の小さな
  常駐バイナリにし、同期エンジンの Node をその子プロセスにする。
  Tauri のトレイ実装をほぼ流用でき、現在の main が持っている資産が活きる
- **(3) main を「ウィンドウを持たないモード」で常駐させる** — 実質は現状維持に近く、
  「daemon が常駐」という設計意図には届かない

**現時点の見立ては (2)。** ただし sidecar のビルド経路（`build-tauri-sidecar.mjs`、
`externalBin`、`prepare-tauri-config.mjs`）が二重になるため、着手前に構成を詰めること。

## 関連する予約作業

`services/sync-daemon` を `services/` の外（`native/` 配下など）へ移す件は
[variant 計画](workbench-native-variant-apps-plan.md)に予約作業として記録済み。
**本改修で daemon の構成を変えるなら、同時にやるのが合理的**。追従が必要な経路は 4 つ:

- ルート `package.json` の workspace glob `services/*`
- `services/sync-daemon/scripts/build-tauri-sidecar.mjs` の出力パス
- Tauri の `externalBin`
- `prepare-tauri-config.mjs` が読む sidecar マニフェスト

## 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| R0 | 実装言語・構成の決定（上記 (1)〜(3)） | [pending] |
| R1 | 常駐部の受け皿を作る（トレイ・ショートカット） | [pending] |
| R2 | main の起動経路を daemon 側に作る | [pending] |
| R3 | main から常駐責務を外す（`residentMode` 撤去） | [pending] |
| R4 | `exitWhenIdle` の「使用中」を (a) へ戻す | [pending] |
| R5 | 実機確認 | [pending] |
