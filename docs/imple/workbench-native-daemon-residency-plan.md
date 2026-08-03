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

## R0 決定: 二層構成（新規 Rust 常駐クレート）

**2026-08-03 にユーザー合意済み。計画書の選択肢 (2) を採用する。**

常駐部（トレイ・グローバルショートカット・プロセス管理）を **Rust の小さな常駐バイナリ**として
新規クレートに起こし、同期エンジンの Node をその子プロセスにする。

```
native/
  desktop/        Tauri アプリ（ウィンドウを持つクライアント）
  resident/       新規 Rust クレート（常駐部）      ← R1
  sync-daemon/    Node 同期エンジン（resident の子）← 移設先
```

### 判断材料

**`tray-icon` / `global-hotkey` / `tao` / `muda` は既に `Cargo.lock` にある**（Tauri の推移的依存）。
Tauri のトレイ・ショートカットプラグインはこれらの薄いラッパでしかなく、素の Rust バイナリから
同じクレートを直接使える。**新しい依存ファミリを持ち込まずに常駐部を作れる**ということ。

これが選択肢の重み付けを決めた:

- **(1) Node + ネイティブアドオン** — 結局 `tray-icon` 系と同じ実装に、node native addon +
  プラットフォーム別 prebuild という**遠回りで重い経路**で辿り着くだけ。却下。
- **(3) main のウィンドウ無しモード** — `tauri_plugin_single_instance` が入っているため、
  `workbench-native.exe` の 2 回目の起動は**新プロセスを立てず 1 個目に転送される**
  （[lib.rs:103](../../native/desktop/src-tauri/src/lib.rs#L103)）。常駐部とウィンドウ持ちアプリが
  **同一プロセスに合流する**ので、役割の反転が原理的に達成できない。却下。

なお検討の過程で「**既存 Tauri バイナリの 5 つ目の variant**として常駐部を作る」案も出た
（identifier `com.workbench.desktop.resident` で single-instance のドメインを分ける）。
トレイ・ショートカット・applog・daemon 起動／リースのコードと `build-variants.mjs` を丸ごと
再利用でき新規ビルド経路がゼロになる利点があったが、**常駐プロセスが Tauri ランタイムを
抱え続ける**点を嫌って不採用。R1 が難航した場合の退避先としてここに残しておく。

### 対価（承知のうえで払うもの）

新規クレート側に**書き直しが必要なもの**。いずれも main 側に既存実装があるので、
移植元として参照すること:

| 必要なもの | 移植元 |
|---|---|
| トレイアイコンとメニュー | `initialize_tray_icon`（[lib.rs](../../native/desktop/src-tauri/src/lib.rs)） |
| グローバルショートカット | [shortcuts.rs](../../native/desktop/src-tauri/src/shortcuts.rs) |
| ログ出力 | [applog.rs](../../native/desktop/src-tauri/src/applog.rs) — **リリースビルドで唯一の手がかり。最初に移すこと** |
| daemon の二重起動防止 | [daemon_guard.rs](../../native/desktop/src-tauri/src/daemon_guard.rs) |
| daemon 起動・readiness 待ち・sidecar 解決 | `commands.rs` の `spawn_daemon` / `resolve_*_sidecar` |
| 設定ファイル読み書き | `commands.rs` の `read_daemon_preferences_from_disk` |

加えて、常駐バイナリをバンドルへ載せる経路が新設になる（`externalBin` が 2 本になる。
`prepare-tauri-config.mjs` の `sidecarManifestExternalBins()` は既に配列を返す作りなので、
受け口自体は用意されている）。

### ログイン時の自動起動

**常駐 exe を HKCU の Run キーに登録し、UI からトグルできるようにする。**

`tauri-plugin-autostart` は `tauri::Runtime` に依存するため**非 Tauri クレートでは使えない**。
同じ意味論を、以下のどちらかで実装する（R1 で確定）:

- `auto-launch` クレート（`tauri-plugin-autostart` が内部で使っているもの）を直接使う
- 既に依存している `windows-sys` に `Win32_System_Registry` を足して Run キーを直接書く
  （このリポジトリは launch mutex を `windows-sys` で手書きしている前例がある）

NSIS テンプレートには**アンインストール時に Run キーを消す処理が既にある**
（[installer.nsi:902-907](../../native/desktop/src-tauri/nsis/installer.nsi)）ので、書き込み側だけを足せばよい。

## R0.5: `services/sync-daemon` → `native/sync-daemon` の移設

[variant 計画](workbench-native-variant-apps-plan.md)の予約作業。**R1 より前に、パス移設だけの
単独 commit として片付ける**（2026-08-03 ユーザー合意）。R1 以降は常駐部が daemon を指す新規コードを
書くので、先に移しておかないと同じ箇所を二度書き換えることになる。移設だけを隔離しておけば、
壊れたときの切り分けが residency 改修と混ざらない。

追従が必要な箇所（調査済み）:

| 箇所 | 内容 |
|---|---|
| ルート `package.json` | workspace glob が `services/*` なので `native/sync-daemon` を明示追加 |
| `package-lock.json` | `npm install` で再生成 |
| `native/desktop/scripts/prepare-tauri-config.mjs:88` | sidecar マニフェストのパス |
| `native/desktop/src-tauri/tauri.conf.json` | `externalBin`。ただし `tauri:prepare` が再生成する |
| `native/desktop/src-tauri/src/commands.rs:730` | dev 用 sidecar 探索ルートの `"services/sync-daemon"` |
| `src/capture/supervisor.ts:51`, `src/capture/screenshotScheduler.ts:28` | cwd 相対の PowerShell スクリプト fallback |
| `src/__tests__/routeCoverage.test.ts:32-34` | repoRoot 相対の daemon ソースパス |
| `scripts/smoke-secure-identity.mjs:14` | エラーメッセージ中の workspace 名 |

**移設後も変更不要なもの**（確認済み）:

- `scripts/build-tauri-sidecar.mjs` — `repoRoot` を `resolve(daemonRoot, "../..")` で出しており、
  `services/sync-daemon` と `native/sync-daemon` は同じ深さなので結果が変わらない
- `src/__tests__/*` の `repoRoot = resolve(__dirname, "../../../..")` — 同上
- `native/desktop/package.json` の `sidecar:build` — `--workspace sync-daemon` と
  **パスではなくパッケージ名**で指しているため、glob が拾えばそのまま通る
- NSIS の `CheckIfAppIsRunning "workbench-sync-daemon.exe"` — 成果物名でありソース位置と無関係

## 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| R0 | 実装言語・構成の決定 | [done] 二層構成（新規 Rust クレート）。2026-08-03 合意 |
| R0.5 | `services/sync-daemon` → `native/sync-daemon` 移設（単独 commit） | [pending] |
| R1 | 常駐部の受け皿を作る（トレイ・ショートカット・ログイン起動） | [pending] |
| R2 | main の起動経路を daemon 側に作る | [pending] |
| R3 | main から常駐責務を外す（`residentMode` 撤去） | [pending] |
| R4 | `exitWhenIdle` の「使用中」を (a) へ戻す | [pending] |
| R5 | 実機確認 | [pending] |
