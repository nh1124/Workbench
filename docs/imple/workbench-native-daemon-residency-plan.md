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

**実施時に見つかった、事前調査から漏れていた 2 箇所**:

- `.gitignore` の `services/*/dist/` — 移設で**この glob が効かなくなり**、ビルド成果物
  （Node SEA の exe を含む）が一括で追跡対象に浮上する。`native/sync-daemon/dist/` を追加した。
- `commands.rs` の `has_sync_daemon_workspace` — `join("services").join("sync-daemon")` と
  **パスが分割されていて grep に掛からなかった**。これは dev モードで repo root を特定する
  判定なので、外していれば `npm run dev --workspace` の cwd が静かに狂う。
  `git grep "services/sync-daemon"` だけでは足りない、という教訓。

**移設後も変更不要なもの**（確認済み）:

- `scripts/build-tauri-sidecar.mjs` — `repoRoot` を `resolve(daemonRoot, "../..")` で出しており、
  `services/sync-daemon` と `native/sync-daemon` は同じ深さなので結果が変わらない
- `src/__tests__/*` の `repoRoot = resolve(__dirname, "../../../..")` — 同上
- `native/desktop/package.json` の `sidecar:build` — `--workspace sync-daemon` と
  **パスではなくパッケージ名**で指しているため、glob が拾えばそのまま通る
- NSIS の `CheckIfAppIsRunning "workbench-sync-daemon.exe"` — 成果物名でありソース位置と無関係

## 実装の構成（R1〜R4 完了時点）

```
native/
  shared/     workbench-shared … 両者が一致していなければならないもの（Tauri 非依存）
  resident/   workbench-resident … トレイ・ショートカット・daemon の寿命
  desktop/    Tauri アプリ … ウィンドウを持つクライアント
  sync-daemon/ Node 同期エンジン … resident の子プロセス
```

### `native/shared` を切った理由

R0 の想定では resident が daemon を spawn するだけのつもりだったが、実装に入って
**daemon 起動の env 構成が account 認証情報に深く結びついている**ことが分かった。
`WORKBENCH_ACCESS_TOKEN` / `WORKBENCH_SYNC_ROOT` / `WORKBENCH_SYNC_ROOT_ID` は
Credential Manager のセッションとアカウント別フォルダ規則から導出され、
sidecar 解決・二重起動防止・readiness 待ちもそこに連なる。

これを resident 側に複製すると「**どの sync root か**」の実装が 2 つできる。食い違ったときの
症状は「daemon が間違ったフォルダを静かに同期する」で、バグらしく見えない。
そこで **Tauri 非依存の共有クレートに 1 つだけ置き**、アプリ側はそれを `#[tauri::command]` で
包むだけにした。`commands.rs` は 2142 行 → 約 600 行。

含めたもの: `secure_storage` / `account` / `paths` / `preferences` / `loopback` /
`launch_guard` / `daemon` / `shortcuts` / `log`。

### プロセス間の取り決め（ファイル 3 つ）

すべて `%APPDATA%\com.workbench.desktop\` に置く。IPC を作らなかったのは、
resident は**アプリが 1 つも起動していない状態でも最後の設定で動けなければならない**ため。

| ファイル | 書き手 | 読み手 |
|---|---|---|
| `daemon-preferences.json` | アプリ（設定画面） | 両方 |
| `global-shortcuts.json` | アプリ（`set_global_shortcuts`） | resident（2 秒ポーリング） |
| `workbench-native.log` | 両方（`[resident]` / `[main]` などのタグ付き） | 人間 |

ショートカット設定の UI は**一切変えていない**。アプリの `set_global_shortcuts` が
「登録する」から「書き出す」に変わっただけ。

### アプリの起動経路

resident はアプリのプロセス内にウィンドウを作れないので、**exe を引数付きで起動する**。
既にアプリが起動していれば `tauri-plugin-single-instance` が引数を既存プロセスへ転送するため、
**1 つのコマンドで「開く」と「もう 1 枚出す」の両方が成立する**。

| 要求 | コマンド |
|---|---|
| メインウィンドウ | `workbench-native.exe` |
| Quick Note | `workbench-native.exe --quick-note-window=1` |
| カレンダー | `workbench-native.exe --calendar-window=1` |

改修前は single-instance ハンドラが**メインウィンドウしか開かず**、`quick-note-window=1` を
持った 2 回目の起動は届いた上で何もしていなかった（[launch_intent.rs](../../native/desktop/src-tauri/src/launch_intent.rs)）。

### R4「使用中」の定義

**リースはウィンドウの有無に直接結びついている。** heartbeat が毎回ウィンドウを数え、
無ければ手放し、また開けば取り直す。resident はリースを取らない（利用者ではないため）。

当初は「`residentMode` を撤去したのでアプリは最後のウィンドウと一緒に終了する。よって
プロセスが生きている＝ウィンドウがある」として済ませたが、**その仮定は破れる**。
経緯は下の R5 の節を参照。

`exitWhenIdle` = on のとき: 最後のウィンドウが閉じる → リース解放 → 猶予 60 秒 → daemon 終了。
トレイは残る。次にアプリを起動するとき resident が daemon を起こし直す。

実行中の daemon がどう思っているかは `/status` の `exitWhenIdle` と `leaseCount` で見える。
**終了しないときは、まずこの 2 つを見る**（設定が届いていないのか、誰かが握っているのか）。

## 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| R0 | 実装言語・構成の決定 | [done] 二層構成（新規 Rust クレート）。2026-08-03 合意 |
| R0.5 | `services/sync-daemon` → `native/sync-daemon` 移設（単独 commit） | [done] 2026-08-03 |
| R1 | 常駐部の受け皿（トレイ・ショートカット・ログイン起動・ビルド経路） | [done] 2026-08-04 |
| R2 | main の起動経路を resident 側に作る | [done] 2026-08-04 |
| R3 | main から常駐責務を外す（`residentMode` 撤去） | [done] 2026-08-04 |
| R4 | `exitWhenIdle` の「使用中」を (a) へ戻す | [done] 2026-08-04。当初は R3 の帰結として済ませたが**仮定が甘く**、R5 で直接実装に直した |
| R5 | 実機確認 | [in-progress] 1〜3・5〜7 確認済み、4・8 未確認。下記 2 件を修正 |

## R5 で見つかったもの（2026-08-04）

### 修正: カレンダーのショートカットがアプリ未起動時に無反応

`Ctrl+Alt+C` が「何かウィンドウが開いているときだけ」動いていた。ログに答えがあった:

```
[main] [window] failed to open calendar window (startup):
       invalid app window URL: relative URL with a cannot-be-a-base base
```

`open_calendar_window` は**既存ウィンドウの URL を基準に相対パスを解決する**設計だった。
起動経路では直前に作ったメインウィンドウがまだ `about:blank` で、これは base になれない URL
なので join が失敗する。**ショートカットが最も要る「何も開いていない状態」だけが壊れる**という
順序になっていた。

`WebviewUrl::App` はルート相対パスをアプリ自身の URL に join する（tauri の
`manager/webview.rs`）ので、**他のウィンドウに一切依存せず**解決できる。そちらへ寄せた。
併せて起動経路でメインウィンドウを先に開くのもやめた（カレンダーを頼まれただけなので）。

エスケープ検査は「origin 比較」から「**ルート相対しか受け付けない**」に変えた。より単純で強い。
ただし `//evil.example` と `/\evil.example` は join 先で別ホストになるため明示的に弾く
（http では `\` が `/` と同じに扱われる）。

### 変更: トレイの Quit がアプリも閉じるようになった

ユーザー指摘「daemon が止まったら他アプリも同時に停止させて良い（アプリ動作＝daemon 動作）」。
daemon だけ止めるとアプリはローカル API が死んだ状態で残り、トレイにも復帰手段が無くなる。

実装は [shutdown.rs](../../native/resident/src/shutdown.rs)。`WM_CLOSE` を投げる（閉じるボタンと
同じ経路なのでアプリ側の既存処理を通る）。**どのウィンドウを閉じるかは実行ファイルのフルパスで
判定**する。最初はリース登録簿の pid を使う実装にしたが、**「daemon が既に止まっている」場合に
読めない**——それはまさにウィンドウが取り残されて閉じたい状況なので、依存を外した。
フルパスなのは、たまたま同名の exe を巻き込まないため。

### 修正: Quit の後、アプリを起動しても resident が戻らなかった

トレイの Quit は resident 自身も止める。その後アプリを起動しても、**resident を起こす経路が
どこにも無かった**——トレイアイコンもグローバルショートカットも無く、daemon を保つものも無い
まま、次のログインまで「半分インストールされたような」状態が続く。

ユーザー要望「アプリを立ち上げたら、必ずトレー上に居るようにしたい」に対応。
アプリの起動時に resident が居なければ起こす（[shared/src/resident.rs](../../native/shared/src/resident.rs)）。
**Quit は「今は使わない」、アプリを開くのは「また使う」**なので、これで筋が通る。

「resident が動いているか」の判定は**単一インスタンス用の名前付き mutex を開けるか**で行う。
プロセス列挙より確実で、resident 自身が二重起動を拒むのに使っているものと同一の錠前になる
（だから `single_instance` は resident から shared へ移した）。競走しても安全で、
負けた側の resident は錠前が取れず即座に終了する。

### 修正: リースを「プロセスが生きている」ではなく「ウィンドウがある」に結び直した

`exitWhenIdle` を on にしても daemon が終了しない、という報告から。原因は R4 の**私の仮定**。

R4 の項で「`residentMode` を撤去した結果アプリは最後のウィンドウと一緒に終了するので、
(b) の実装がそのまま (a) の意味になった」と書いた。**この仮定が成り立たない場合がある。**

実機を調べたところ、`workbench-native` が**可視・不可視あわせてウィンドウを 1 つも持たないまま
生存し、リースを更新し続けていた**。リース数がゼロにならないので、設定値が何であれ daemon は
永久に idle 終了しない。

Tauri が終了を決めるのは「ウィンドウの `Destroyed` がレジストリを空にした瞬間」だけで
（`tauri-runtime-wry/src/lib.rs`、`TaoWindowEvent::Destroyed`）、その経路を外れて
ウィンドウを失ったプロセスは生き残る。**ほぼ常に成り立つが、常にではない。**

そこで計画書がもともと書いていた (a) を**仮定でなく直接**実装した:
heartbeat が毎回 `app.webview_windows()` を見て、空ならリースを手放し、
また開いたら取り直す（[daemon_lease.rs](../../native/desktop/src-tauri/src/daemon_lease.rs)）。

**ウィンドウを失ったプロセスが生き残る条件そのものは未特定。** 再現に必要な情報が無かったため、
その状態に入ったら app ログに 1 行残すようにしてある。次に起きたら原因が分かる。
プロセスを自動終了させるのは見送った——単一インスタンスの受け口を兼ねているため、
転送されてくる起動要求と競走する。

### 追加: daemon の idle 方針を観測可能にした

この診断に時間がかかった理由は単純で、**`exitWhenIdle` が実行中の daemon でどうなっているかを
見る手段がどこにも無かった**こと。「daemon が終了しない」と「設定が daemon に届いていない」が
区別できなかった。

- `/status` に `exitWhenIdle` と `leaseCount` を追加
- daemon 起動時に idle 方針と猶予秒数をログに出す
- `PUT /leases/policy` で変更されたときもログに出す

### 未修正の papercut

`exitWhenIdle` = on だと、アプリの起動が daemon の起動と毎回競走する。設定画面は状態を
一度しか読まないので `(local GET /status): Connection failed: Failed to fetch` が出やすい。
リロードすれば直る。R4 以前から在る競走だが、daemon が終了する頻度が上がったため目に付く。
