# Workbench Native: 機能単位アプリ（variant）化計画

Tasks / Notes / Artifacts を、機能そのままに **独立した Windows アプリ**として配布し、タスクバーに機能単位で
ピン留めできるようにする。併せて sync-daemon の**プロセス横断の多重起動防止**を入れる。

実装体制は Codex worker delegation（Claude=調査/計画/レビュー/commit、Codex=wave 実装）。
ただし 2026-08-02 現在、Codex は 30 分タイムアウトで空振りすることが多く、実績としては Claude 直接実装が主。

---

## 現状インデックス（2026-08-02 時点・ここだけ読めば全体が分かる）

この計画書は 4 フェーズを追記で重ねたため節の順序が時系列でなく、単独で読むと迷子になる。
**個別の節より、この表が正**。

### フェーズ一覧

| Phase | 目的 | 状態 |
|---|---|---|
| 1 | variant 化の基盤（別 exe / ビルド / ルーティング） | コード完了。実機は一部未検証 |
| 2 | 実使用フィードバックによる改良（見た目・導線・インストーラ） | **P2-3b のみ継続中**。他は完了 |
| 3 | native UI を web から完全独立（fork） | 完了（N4 = 以後の native 最適化は継続タスク） |
| 4 | daemon を独立アプリ化（参照カウンタ） | **進行中。D3 が未了で効果が出ていない** |

### いま動いている作業（残タスク）

| # | 作業 | 所属 | 状態 |
|---|---|---|---|
| 1 | **D3** アプリ側リースクライアント（取得・ハートビート・解放、`stop_daemon` 置換） | Phase 4 | **完了** 2026-08-02。実機未検証 |
| 2 | **D4** Settings に `exitWhenIdle` トグル | Phase 4 | **完了** 2026-08-02。実機未検証 |
| 3 | ~~Tasks: フィルタ → フォルダの意味論変更~~ | Phase 2 (P2-3b) | **中止** 2026-08-02。フィルタ形式のまま維持 |
| 4 | Notes: 複数選択（shift/ctrl + 右クリック一括） | Phase 2 (P2-3b) | **完了** 2026-08-02。実機未検証 |
| 5 | 実機再確認（下記） | 全体 | **必須。現インストール版は 4 コミット遅れ** |

### 未対応と割り切った既知課題

| 課題 | 理由 |
|---|---|
| `daemon-preferences.json` の lost update（複数プロセスの read-modify-write 競合） | 設定共有で顕在化した構造問題。別途 |
| loopback probe に全体締切が無い（read ごとのタイムアウトのみ） | 実害限定的 |
| `services/sync-daemon` を `services/` 外へ移す | 予約作業。Phase 4 完了・実機確認後 |
| `File item not found` / Sync issue | サーバ側 Artifacts の 404。今日の変更以前から存在。別件 |
| **daemon と main の役割が反転している** | 別計画へ切り出し済み → [daemon-residency-plan](workbench-native-daemon-residency-plan.md)。variant 分割の完了後に着手 |

### 実機で未検証のもの（重要）

**現在インストールされているビルドは `d392bbd` 時点**で、以下を含まない。

- `f51ed71` 起動ガードの修正（ミューテックス待機 ≥ レディネス待ち）
- `893947e` daemon リース登録簿（D3 未了のため現状は無効）
- `46eced0` タイトルバーのはみ出し修正
- `c1435ba` Tasks のビュー切替を枠へ

したがって **daemon 同時起動ガードは今も未検証**。Phase 1 Wave 6 が `[partial]` のままなのはこのため。
D3 まで進めてから再ビルドし、まとめて確認するのが手戻りが少ない。

## 背景と決定事項

### なぜ「別 exe」なのか（方式Bの採用理由）

Windows のタスクバーボタンは **AppUserModelID (AUMID)** 単位でグループ化される。既定では AUMID は exe パスから
導出されるため、「1 つの exe が Tasks 用ウィンドウと Notes 用ウィンドウを開く」構成では**同一ボタンに束ねられ、
アイコンも 1 つ**になる。分離するには次のいずれかが要る。

- **方式A（不採用）**: 1 バイナリ + ウィンドウごとの AUMID 明示設定（`SHGetPropertyStoreForWindow` +
  `System.AppUserModel.ID` / `RelaunchCommand` / `RelaunchIconResource`）+ NSIS テンプレート自作。
  ウィンドウ表示前に設定する必要があり壊れやすく、NSIS テンプレートの自前保守が発生する。
- **方式B（採用）**: 同一クレートを identifier / productName / icon 違いで複数回ビルドし、別インストーラとして配布。
  exe が別なので**タスクバー分離・アイコン・ピン留めは Windows が自動で行う**。AUMID も NSIS テンプレートも不要。

### 方式Bが既存実装と噛み合う点（調査で確認済み）

- [`prepare-tauri-config.mjs`](../../native/desktop/scripts/prepare-tauri-config.mjs) は既に env 駆動
  （`NATIVE_APP_NAME` / `NATIVE_APP_IDENTIFIER` / `NATIVE_WINDOW_TITLE`）。variant はこの延長線上に置ける。
- `tauri-plugin-single-instance` は `app.config().identifier` からミューテックス名を作る
  （`tauri-plugin-single-instance-2.4.0/src/platform_impl/windows.rs:58-70`）。identifier を分けるだけで
  **アプリごとに独立した単一インスタンス**になる。
- ログインセッションは Credential Manager の `Workbench.Session` という**ハードコード target 名**
  （[`secure_storage.rs:6`](../../native/desktop/src-tauri/src/secure_storage.rs)）。variant 間で共有され、
  ログインし直しは不要。
- 初期表示の出し分けは `index.html?quick-note-window=1` と同じクエリ方式が既にある
  （[`App.tsx:45-50`](../../ui/src/App.tsx)）。`/tasks` `/notes` `/artifacts` のルートも既存。

### 許容する制約

- インストーラは 4 本（各 25MB 前後）。更新時は 4 本入れ直す。
- 同時起動中は WebView2 プロセスが variant ごとに立つ（メモリ増）。
- **localStorage は identifier ごとの WebView2 データフォルダに分かれる**ため、サーバ URL の指定は
  アプリごとに初回 1 回ずつ必要。これはオープンソースとして「毎回ログイン画面でサーバを指定する」設計意図
  （複数インスタンスの乱立を許す）と矛盾しないため、共有化はしない。
- ~~`daemon-preferences.json` は `app_config_dir()` 由来のため variant ごとに分かれる。sync フォルダなどの
  設定は variant ごとに持つ。~~ **2026-08-02 撤回。設定は共有する（下記「設定の共有」）。** daemon 本体は共有。

## variant レジストリ（確定仕様）

| variant | productName | identifier | 初期ルート | icon dir | window title |
|---|---|---|---|---|---|
| （なし＝main） | `Workbench Native` | `com.workbench.desktop` | `/`（`startPage` 設定に従う） | `icons` | `Workbench` |
| `tasks` | `Workbench Tasks` | `com.workbench.desktop.tasks` | `/tasks` | `icons/tasks` | `Workbench Tasks` |
| `notes` | `Workbench Notes` | `com.workbench.desktop.notes` | `/notes` | `icons/notes` | `Workbench Notes` |
| `artifacts` | `Workbench Artifacts` | `com.workbench.desktop.artifacts` | `/artifacts` | `icons/artifacts` | `Workbench Artifacts` |

アイコンは新規作成済み。元 SVG は [`native/desktop/icons-src/`](../../native/desktop/icons-src/) に版管理し、
`npx tauri icon icons-src/<name>.svg -o src-tauri/icons[/<variant>]` で再生成できる。

Rust 側は **`app.config().identifier` の suffix から variant を導出**する（ビルド時の env 追加は不要）。
`com.workbench.desktop` → main、`com.workbench.desktop.tasks` → `tasks`。

### main と variant の挙動差（確定）

| 機能 | main | variant |
|---|---|---|
| トレイアイコン | あり | **なし**（4 個のトレイ常駐は煩雑なため） |
| 閉じたときの常駐（close→hide） | あり（`residentMode`） | **なし**（通常どおり閉じる） |
| sync-daemon の起動 | する | **する**（下記の多重起動防止つき） |
| Quick Note / Calendar ウィンドウ | あり | あり（既存コマンドをそのまま使う） |

variant が hide 常駐しない理由: トレイが無いと復帰導線が無くなるため。閉じたら終了し、ピン留めアイコンから
再起動する（single-instance が identifier 単位で効くので二重起動にはならない）。

## sync-daemon の多重起動防止（確定設計）

### 現状の問題

- 排他は `managed_daemon()` の `static Mutex` のみで、**プロセス内に閉じている**。variant が増えると
  プロセス横断で無防備になる。
- sync-daemon 側は `server.listen()` に `error` ハンドラが無い（[`statusServer.ts:1431`](../../services/sync-daemon/src/statusServer.ts)）ため、
  ポート衝突時は uncaught exception で落ちる。ただし `startStatusServer` は
  **capture 開始・identity 登録の後**に呼ばれる（[`index.ts:585-591`](../../services/sync-daemon/src/index.ts)）。
  つまり重複起動した daemon は**落ちる前に同じ sync root へ実作業をしてしまう**。ポート衝突による自然死は
  ガードとして不十分であり、明示的なガードが必要。

### 方針

daemon は Workbench の共通基盤とみなし、**variant であっても「立っていなければ起動する」**。ただし
既に立っていれば起動せず、それを利用する（adopt）。

1. **起動判定**: spawn 前に `127.0.0.1:<port>/status` を叩く（既存の `read_loopback_status` を再利用）。
   応答があれば生存中とみなし spawn しない。
2. **競合防止**: 「判定 → spawn」を**プロセス横断の名前付きミューテックス**で直列化する。
   Windows は `CreateMutexW`（`Local\workbench-sync-daemon-launch`）。variant を同時に起動した場合
   （スタートアップ、複数ピンの同時クリック）に両方が「居ない」と判定して二重 spawn するのを防ぐ。
   `windows-sys` に `Win32_System_Threading` feature を追加する。
   Windows 以外は排他ファイル（`create_new`）でのフォールバックとし、取得できなければ probe のみで続行する。
3. **所有権**: spawn した側だけが `managed_daemon()` に `Child` を持つ。adopt した側は持たない。
   `stop_daemon` は**自分が spawn した daemon のみ**を停止する（他プロセスの daemon は殺さない）。
   状態を UI から判別できるよう、daemon 状態のレスポンスに `owned: boolean` を含める。

戻り値の意味論（`start_daemon` は現在 `bool` を返す）:

- `true` = このプロセスが新規に spawn した
- `false` = 既に起動していた（プロセス内 / 他プロセスのどちらでも）

既存の呼び出し側（`set_daemon_core_url` の再起動経路）は「自分が所有していない daemon は停止も再起動もしない」
＝ `stop_daemon()` が `false` を返すので `start_daemon_with_app` を呼ばない、という現行コードの分岐で
正しく動く。ここは変更しない。

## レビューで判明した訂正（実装中に確定）

### 訂正1: variant の初期 URL は `?app=<variant>` であって `index.html?app=<variant>` ではない

Tauri は App URL を**完全一致文字列 `"index.html"` のときだけ**サイトルートへ簡約する
（`tauri-2.10.3/src/manager/webview.rs:421-429`）。したがって `index.html?app=tasks` は
`pathname == "/index.html"` になり、React Router では `path="*"` の NotFoundPage に落ちる。
クエリのみの相対参照 `?app=tasks` はベースパスを保つため `pathname == "/"` になる。
既存の quick-note ウィンドウが `index.html?quick-note-window=1` で動いているのは、
`App()` がルーターより前に `<QuickNoteWindowPage/>` を返しているからであり、ルーティングの前例にはならない。

### 訂正2: 起動ガードは spawn 直後に解放してはいけない

当初設計は「判定 → spawn」をミューテックスで囲むだけだったが、生存判定がポート応答ベースであるため、
spawn 直後に解放すると **daemon がまだポートを bind していない窓**が残り、次の variant が
「居ない」と判定して二重 spawn する。ガードは spawn 後も保持し、`daemon_is_running_externally()` が
真になるまで 250ms 間隔・最大 20 秒ポーリングしてから解放する。

これに伴う 2 つの制約:

- ポーリング中に `managed_daemon()` の in-process ロックを握ったままにしない。`read_daemon_status` が
  同じロックを取るため、UI の状態取得が最大 20 秒ハングする。子プロセス格納後に明示的に `drop` する。
- `start_daemon_if_auto_start_enabled` は `setup()`（メインスレッド）から呼ばれるため、
  そのまま待つと起動が最大 20 秒フリーズする。`std::thread::spawn` に逃がす。
  Windows の名前付きミューテックスは**待機したスレッドが所有者**であり `ReleaseMutex` も同一スレッドから
  行う必要があるため、ガードをスレッド間で移動させてはならない。

## Wave 分割

### Wave 1: variant 設定基盤（ビルド構成）

- `prepare-tauri-config.mjs`: `NATIVE_APP_VARIANT` を受け、variant レジストリから productName / identifier /
  icon / window title を解決。未指定時は**現行の挙動を完全に維持**する（既存 env が正）。
- `native/desktop/package.json`: `tauri:build:variant`、ルート `package.json`: `build:native:all`
  （main → tasks → notes → artifacts を順にビルド）。
- 検証: `NATIVE_APP_VARIANT=tasks node scripts/prepare-tauri-config.mjs` で生成 JSON が期待どおりであること。
  variant 未指定で生成した JSON が現行と同一であること。

### Wave 2: Rust 側の variant 挙動

- `variant.rs`（新規）: `app.config().identifier` から variant を導出。`Variant::{Main, Tasks, Notes, Artifacts}`。
- `window.rs`: variant のとき初期 URL を `index.html?app=<variant>` にする。close→hide の常駐は main のみ。
- `lib.rs`: トレイ初期化は main のみ。daemon 自動起動は variant でも実行（Wave 3 のガード前提）。
- 検証: `cargo check`、variant 導出の単体テスト。

### Wave 3: sync-daemon のプロセス横断ガード

- `commands.rs`: 上記「方針」1〜3 の実装。`Cargo.toml` に `Win32_System_Threading` 追加。
- 検証: `cargo test`。ロック取得/解放、probe 成功時に spawn しないこと、`owned` フラグ。

### Wave 4: UI 側の variant 受け口

- `App.tsx`: `?app=<variant>` を読み、対応ルートを初期表示（`quick-note-window=1` と同じ位置で分岐）。
  未知の値は無視して通常起動（フォールバック）。
- 検証: `npx tsc --noEmit`、`npm test --workspace ui`。

### Wave 5: ビルド・実機確認（Claude 実施）

- `npm run build:native:all` で 4 本のインストーラ生成。
- 実機で: タスクバーに 3 つを個別ピン留め／daemon が 1 つしか立たないこと（`tasklist` で確認）／
  main を落としても variant から daemon が立つこと。

## テスト戦略

- Rust: variant 導出、daemon ガード（probe 成功 → spawn しない、ロック競合）。
- UI: `?app=` パース（未知値のフォールバック含む）。
- 生成物: variant 別 `tauri.conf.json` のスナップショット的検証（Wave 1 の検証コマンド）。
- 実機: Wave 5。多重起動防止は **daemon プロセス数の実測**で確認する（単体テストでは不十分なため）。

## ロールバック

variant は追加のみで、main の構成・挙動は不変。問題があれば variant のインストーラを配布しない／
アンインストールするだけで戻せる。Wave 3 の daemon ガードのみ main にも影響するため、
ここは独立 commit にして単独で revert できるようにする。

## 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| 0 | 調査・アイコン新規作成・計画書 | [done] 2026-07-31 |
| 1 | variant 設定基盤（prepare-tauri-config / build スクリプト） | [done] 2026-07-31 |
| 2 | Rust 側の variant 挙動（variant.rs / window.rs / lib.rs） | [done] 2026-07-31 |
| 3 | sync-daemon プロセス横断ガード | [done] 2026-07-31 |
| 4 | UI 側 `?app=` 受け口 | [done] 2026-07-31 |
| 5 | 4 本ビルド | [done] 2026-07-31 |
| 6 | 実機確認（インストール・ピン留め・daemon 単一性） | [partial] 2026-08-02 起動・ピン留め・着地は OK。同時 spawn ガードは未検証 |

検証結果（2026-07-31）: `cargo test` 15 件パス、`npx tsc --noEmit` 通過、ui vitest 448 件パス、
`npm run build:native:all` で 4 本の NSIS / MSI 生成。

実装体制の実績: Wave 1〜3 は Codex 実装 + Claude レビュー。Wave 4 は Codex が 2 回連続で 30 分タイムアウトし
出力が無かったため Claude が直接実装した（`window.rs` の URL 修正、`App.tsx` の `resolveVariantStartPage`、単体テスト）。

---

# Phase 2: 実使用フィードバックによる改良（2026-08-01）

Phase 1 を実機で使った結果、4 点の課題が出た。方式B（別 exe）は維持し、共有と専用化で解決する。

| フィードバック | 対応 |
|---|---|
| 再ログインしないとタスクが表示されない | P2-1 ストレージ共有 |
| アイコンを黒基調のシンプルなものに | P2-2 アイコン再作成 |
| 各アプリが別々で勝手が悪い | P2-1 + P2-4（1 インストーラ化） |
| 専用アプリなのに UI が同じ | P2-3 専用シェル + 各機能の最適化 |

## P2-0: 「再ログインしないとデータが出ない」の真因（2026-08-01 訂正）

**P2-1 の当初診断は誤りだった。** ストレージ分離は症状の原因ではない。

真因は [`getWorkbenchCoreUrl()`](../../ui/src/config/services.ts) の分岐にある。

```js
workbenchCoreUrlCache = isServedByWorkbenchCore()
  ? currentOriginWorkbenchCoreUrl() || readStoredWorkbenchCoreUrl() || envWorkbenchCoreUrl
  : readStoredWorkbenchCoreUrl() ?? envWorkbenchCoreUrl;
```

`isServedByWorkbenchCore()` は「protocol が http/https」かつ「本番ビルド（`!import.meta.env.DEV`）」で true を返す。
パッケージ版ネイティブは **`http://tauri.localhost`** で UI を配信するため、この条件を偶然すべて満たす。
結果、保存済み Core URL を捨てて自分自身のオリジンを Core とみなし、`/api/*` に index.html が返って
JSON パースに失敗していた。共有 localStorage に
`Service returned an HTML error page instead of JSON for http://tauri.localhost/api/tasks?limit=200`
という通知が大量に残っていたのが決定的な証拠。

ログイン直後だけ動くのは `setWorkbenchCoreUrl()` がキャッシュを直接書き換えるため。再起動すると再計算されて
`tauri.localhost` に戻る。**この不具合は variant 固有ではなくメインアプリも抱えていた**（毎回ログインで回避されていた）。

対応: `isServedByWorkbenchCore()` で `tauri.localhost` を除外する。Web 配置（Core が UI を配信）と
ネイティブ dev（`127.0.0.1:5174`）の判定は変えない。テストは
[`servedByCore.test.ts`](../../ui/src/config/__tests__/servedByCore.test.ts)。

P2-1 のストレージ共有自体は設定・通知・UI 状態の共有として有効なので維持する。

## P2-5: daemon をコンソールレスにする

sidecar はコンソールアプリのため、GUI から spawn するとコンソール窓が出ていた。

- `CREATE_NO_WINDOW` を付与して窓を抑止
- 出力は破棄せず `app_config_dir/sync-daemon.log` へリダイレクト
- トレイメニューに「Open sync daemon log」を追加し、必要なときだけ確認できるようにする

## P2-1: ストレージ共有

### 当初の診断（誤り。P2-0 参照）

セッションは Credential Manager の固定名 `Workbench.Session` なので variant でも読める。壊れているのは
**サーバー URL** で、`workbench-core-url` は localStorage にあり（[`services.ts`](../../ui/src/config/services.ts)）、
localStorage は WebView2 のユーザーデータフォルダに紐づく。

Tauri は `data_directory` 未指定だと wry が空文字を `CreateCoreWebView2EnvironmentWithOptions` に渡す
（`wry-0.54.4/src/webview2/mod.rs:345`）。この場合 WebView2 の既定は **exe と同じ場所の
`<exe名>.exe.WebView2`** であり、Electron のような identifier ベースのパスではない。
variant はインストール先が別ディレクトリなので、localStorage も別になっていた。

結果、variant はビルド時に焼き込まれた `http://127.0.0.1:4100` にフォールバックしてデータを取得できず、
ログイン画面を通して初めて URL が入る、という症状になっていた。

### 対応

`WebviewWindowBuilder::data_directory()`（`tauri-2.10.3/src/webview/webview_window.rs:1022`）で、
**main を含む全ビルド**が同一の絶対パスを指すようにする。相対パスのみ許すという制約は
`WebviewBuilder::from_config` 経由の場合だけで（`webview/mod.rs:410-419`）、プログラム生成には掛からない。

共有パスは identifier ベースの安定した場所とする: `%LOCALAPPDATA%\com.workbench.desktop\webview`。
main の identifier を定数として使い、`app_local_data_dir()`（variant ごとに変わる）は使わない。

**一度きりの移行コスト**: main の既存 localStorage は exe の隣にあるため引き継がれない。
初回のみ main でもサーバー URL の再指定が必要になる。ログインは Credential Manager にあるため維持される。

WebView2 は複数プロセスによる同一ユーザーデータフォルダの共有をサポートし、ブラウザプロセスを共有する。
副作用として 4 アプリ同時起動時のメモリが減る一方、ブラウザプロセスのクラッシュは全アプリに波及する。

## P2-2: アイコン再作成

Phase 1 の彩度の高いタイルは不採用。**黒基調・シンプル**へ。色相での差別化をやめ、
黒地＋シルバー/白のグリフとし、機能差はグリフ形状と控えめなアクセントで表す。
元 SVG は [`icons-src/`](../../native/desktop/icons-src/) を更新し、`npx tauri icon` で再生成する。

## P2-3: 専用シェルと各機能の最適化

- 既存 [`Layout`](../../ui/src/components/Layout.tsx) は**変更しない**。`?app=` 起動時に使う
  専用シェルを別コンポーネントとして新設する。
- 落とすもの: サイドナビ全体（他機能への導線）、ヘッダーの WORKBENCH 表記・Local 状態・通知など。
- 各機能画面を単機能アプリとして作り込む（余白・情報密度・操作導線）。
- 仕上がりが良ければメイン側へ輸入する前提のため、専用シェル配下の共通部品は
  メインからも使える粒度で切る。

## P2-4: 1 インストーラ化（コンポーネント選択）

- 4 つの exe を **1 つのインストールフォルダ**に入れる。sidecar (`workbench-sync-daemon.exe`) も 1 本で済み、
  variant は `current_exe_parent()` 経由で共有 sidecar を見つけられる。
- exe のパスが異なるため AUMID は自動的に分かれ、タスクバー分離は維持される。
- NSIS のコンポーネントページで、メイン + 導入したい専用アプリだけを選ばせる。
  Tauri の `bundle.windows.nsis.template` でカスタムテンプレートを指定する。
  雛形は生成済みの `target/release/nsis/x64/installer.nsi` を出発点にする。
- ビルド手順: 各 variant をビルドして exe をステージングへ退避 → main のバンドルに `resources` として同梱。

## Phase 2 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| P2-1 | WebView2 データディレクトリ共有 | [done] 2026-08-01 |
| P2-2 | アイコン再作成（黒基調） | [done] 2026-08-01 |
| P2-3a | 専用シェル（サイドバー・ヘッダー除去） | [done] 2026-08-01 |
| P2-3b | 各機能の作り込み（余白・情報密度・操作導線） | [done] 2026-08-02 Notes / Artifacts / Tasks / タイトルバー / 複数選択すべて完了 |
| P2-4 | 1 インストーラ化（コンポーネント選択） | [done] 2026-08-01 |
| P2-5 | daemon をコンソールレス化 + トレイからログ参照 | [done] 2026-08-01 |
| P2-6 | 専用アプリのアカウント行（ログイン/サーバー切替/サインアウト） | [done] 2026-08-01 |
| P2-7A | 装飾オフ + 自前タイトルバー | [done] 2026-08-01 |
| P2-7B | Snap Layouts（WM_NCHITTEST → HTMAXBUTTON） | [done] 2026-08-01 実機で HTMAXBUTTON を確認 |

### P2-7 で踏んだ罠

- **ウィンドウプロシージャから Tauri API を同期呼び出ししてはいけない**。`WM_NCMOUSEMOVE` は頻繁に飛び、
  `webview_windows()` はウィンドウ生成中に握られているロックを取りにいくため、メインスレッドで再入して
  デッドロックし**ウィンドウが一切表示されなくなる**。`run_on_main_thread` でメインループへ委譲すること。
- **タイトルバーを認証ゲートの内側に置いてはいけない**。装飾オフのウィンドウでログイン画面に入ると
  タイトルバーが存在せず、移動も終了もできなくなる。`App.tsx` でルーティングの外側に置く。
- **`startDragging` を mousedown で呼ぶと `dblclick` が発火しない**（OS のドラッグループにポインタが渡るため）。
  ダブルクリック最大化は `event.detail >= 2` で判定する。
- wry の装飾オフは `WS_CAPTION` / `WS_THICKFRAME` を残したまま `WM_NCCALCSIZE` で非クライアント領域を削る方式。
  キャプション高は実測 1px。ただし縁の `WM_NCHITTEST` は `HTCLIENT` を返すため、
  リサイズ境界がネイティブのまま効くとは限らない（未検証）。

### P2-4 の割り切り

コンポーネント選択は NSIS 固有の機能のため、**MSI の生成をやめた**（`--bundles nsis`）。
MSI が要る場合はコンポーネント選択なしの別バンドルとして戻すことになる。

NSIS テンプレートは tauri-cli 2.10.1 のものを
[`src-tauri/nsis/installer.nsi`](../../native/desktop/src-tauri/nsis/installer.nsi) に取り込んで改造している。
**Tauri を上げる際はテンプレートの追従が必要**。取得元は
`https://raw.githubusercontent.com/tauri-apps/tauri/refs/tags/tauri-cli-v<version>/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`。
handlebars プレースホルダを残したまま改造すること（絶対パスを焼き込まない）。

## P2-7: 専用アプリの自前タイトルバー（MS Office 風）

アカウント操作をウィンドウ枠に置く。**専用アプリのみ**先行導入し、メインは据え置き。

Windows にはネイティブ枠を残したままオーバーレイする仕組みが無いため、`decorations: false` で装飾を切り、
タイトルバーを HTML で描く。UI は `@tauri-apps/api` を使わず `window.__TAURI_INTERNALS__.invoke` で
Rust コマンドを呼ぶ方式（[`transport.ts:64-73`](../../ui/src/lib/api/transport.ts)）なので、
ウィンドウ操作も同じ作法の Rust コマンドとして足す。新規依存は不要。

### Wave A: 装飾オフ + 自前タイトルバー

- `window.rs`: variant のときのみ `.decorations(false)`。main / Quick Note / Calendar は変更しない。
- Rust コマンド: `window_minimize` / `window_toggle_maximize` / `window_close` / `window_start_drag`。
  いずれも呼び出し元ウィンドウに対して作用させる（`tauri::Window` を引数に取る）。
- UI: 専用シェルの最上段にタイトルバー。左にアプリ名、右にアカウント（P2-6 の内容を移設）+ 最小化 / 最大化 / 閉じる。
- ドラッグ領域は明示的に `window_start_drag` を叩く（`data-tauri-drag-region` に依存しない）。

### Wave B: Win32 ヒットテスト（Snap Layouts とリサイズ）

装飾オフのままでは Win11 の Snap Layouts（最大化ボタンのホバーで出る分割レイアウト）とリサイズ境界が失われる。
`SetWindowSubclass` でウィンドウをサブクラス化し、`WM_NCHITTEST` を自前処理する。

- 最大化ボタンの矩形上では **`HTMAXBUTTON`** を返す → Windows が Snap Layouts を出す。
- ボタン矩形は UI 側が実測して Rust に渡す（DPI スケール込み）。`WM_NCLBUTTONDOWN` / `WM_NCLBUTTONUP` も
  処理しないとボタンが押せなくなる点に注意。
- 外周 N px では `HTLEFT` / `HTTOP` / `HTTOPLEFT` 等を返してリサイズ境界を復元する。
- `windows-sys` に `Win32_UI_Shell`（`SetWindowSubclass`）と `Win32_UI_WindowsAndMessaging` を追加。

## P2-3b: 各機能の作り込み（進行中）

方針: **枠にアプリ全体の操作、本体は情報表示に専念**。タイトルバーのスロット
（[`VariantChrome.tsx`](../../ui/src/components/VariantChrome.tsx)）へ各ページが portal で差し込む。

### Notes（完了 2026-08-01）

リスト + 編集ペイン、Panels（一覧専用）、タイトルバーに検索 / プロジェクト / 表示切替 / New note。
編集ペインがそのままエディタで、入力停止 0.7 秒後に自動保存。別ウィンドウは Quick Note を再利用。

踏んだ罠:

- `.notes-page` は `width: min(1040px, calc(100% - 7rem)); margin: 0 auto` で中央寄せされる。
  **専用アプリでは明示的に打ち消す必要がある**。Artifacts / Tasks も着手前に各ページの幅制限を確認すること。
- `-webkit-line-clamp` + `display: -webkit-box` はカードの中身が消える形で壊れた。`max-height` + `overflow` を使う。
- プロジェクト名未設定のノートは UUID がそのまま出るため、折り返してタイトルを押し出す。メタ行は 1 行省略に固定。
- ウィンドウ生成は `open_variant_window` を新設したが 2 度とも空白ウィンドウになり、
  **既存の Quick Note ウィンドウ再利用に切り替えた**。新経路を作る前に既存の動く仕組みを検討すること。

### 残作業

| 項目 | 内容 |
|---|---|
| Notes 複数選択 | **完了** 2026-08-02。shift/ctrl 選択 + 右クリックメニュー（一括削除・新規ウィンドウ） |
| Artifacts | 下記「Artifacts の設計」参照。**完了**（実機確認 2026-08-02 OK） |
| Tasks | 切替を枠へ = **完了** 2026-08-02 `c1435ba`。フォルダ化は**中止**（フィルタ形式のまま） |
| タイトルバーの折り返し | **完了** 2026-08-02。中央トラックを clip し、テキスト入力から順に譲る |

### Tasks のフォルダ化は見送り（2026-08-02 中止）

サイドバーを「フィルタの積み重ね」から「単一選択の場所リスト」（MS To Do 型）へ変える案を検討したが、
**ユーザー判断で中止。フィルタ形式のまま維持する。** 実装には入っていない。

調査でわかったことだけ残す（再検討する人が同じ道を辿らないように）:

- 絞り込みは 2 層で積み重なる。`contextFilter`（プロジェクト）は**データ取得の段階**、
  `quickFilter` はクライアント側。
- `QuickFilter` は `today | myday | planned | overdue | inbox` で、**「全件」に相当する値が無い**。
  場所リスト化するなら、プロジェクトを選んだとき用に `"all"` の追加が要る（27 箇所 / 11 ファイル）。
- **それだけでは足りない。** [`TaskListContent.tsx`](../../native/desktop/ui/src/tasks/components/TaskListContent.tsx)
  の分岐は else が `null` で何も描画されず、さらに既存分岐はすべて **occurrence 行**（日付つきの発生
  インスタンス）を描く。そのページングは planned / overdue でしか走らない。
  **「日付に関係なくプロジェクトの全タスク」は occurrence では表現できず**、`tasks` 配列から描く
  新経路が要る——これが実質の新規実装になる。

### Artifacts の設計（2026-08-01 調査で確定）

#### 機能欠落の実体

`Layout.tsx` の [`ArtifactsQuickAccess`](../../ui/src/components/Layout.tsx)（Pinned / Projects / Recent、
プロジェクト行ごとの「+ New Note」）は **`Layout` の中に定義されており、`/artifacts` のときだけ
セカンダリサイドバーとして描画される**。専用アプリは `VariantShell` を使い `Layout` を通らないため、
この導線が丸ごと消えている。これが「プロジェクト選択が不能」の正体。

プロジェクトカードのランディング（`isProjectCardView`）は生きているので選択が完全に不可能なわけではないが、
ピン留め・最近使った項目・プロジェクトの即時切替という常用導線が無い。

#### 方針

- `ArtifactsQuickAccess` とその補助（`buildArtifactsHref` / `ArtifactMenuIcon` / `pinnedArtifactHref` /
  `recentArtifactHref` / `ARTIFACT_PROJECT_ROW_LIMIT`）を `artifacts/components/ArtifactsQuickAccess.tsx`
  へ**純粋な移動**として切り出す。`Layout` は import して従来どおり使う（メインの挙動は不変）。
  P2-3 の「専用シェル配下の共通部品はメインからも使える粒度で切る」に沿う。
- 専用アプリでは `ArtifactsPage` が `useHasTitleBarSlot()` を見て、左レールとして自前で描画する。
  ページ側が持つのは Artifacts 固有の導線なので、`VariantShell` は汎用のまま触らない。
- **枠にアプリ全体の操作**（P2-3b の原則）に従い、`va-toolbar` の検索ボックスとプロジェクト `<select>` は
  専用アプリでは `TitleBarPortal` へ移す。パンくず / Home / Upload / New Folder / New Note / 表示切替は
  「今いるディレクトリ」に対する操作なので `va-toolbar` に残す。
- レールは title bar のトグルで開閉できるようにする（Notes のリスト折りたたみと同じ作法）。
- 余白は `.variant-shell` 配下にスコープした CSS でのみ詰める。メイン側の `va-*` 寸法は変更しない。

#### 罠（Notes から引き継ぐ確認事項）

- `.va-artifacts-page` は `height: 100%` / `overflow: hidden` のグリッド。Notes で踏んだ「中央寄せの幅制限」は
  Artifacts には無いが、レールを足すときに `grid-template-columns` を壊さないこと。
- `.variant-shell .page-frame { padding: 0 }` は既に効いている。残っているのは `.va-toolbar` の
  `0.72rem 1.1rem` などページ内部の余白。
- `ArtifactsPage` は `searchParams` から `isProjectCardView` を導出する。`?app=artifacts` は
  最初のナビゲーションで消えるため干渉しないが、レールのリンクが `?project=` を張る点は変わらない。

#### Wave 分割

| Wave | 内容 | 状態 |
|---|---|---|
| A1 | `ArtifactsQuickAccess` の切り出し + 専用アプリでの左レール描画（開閉トグル込み） | [done] 2026-08-01 `a541a0c` |
| A2 | 検索とプロジェクト選択を title bar へ移設 + `.variant-shell` スコープの余白詰め | [done] 2026-08-01 `e010609` |
| A3 | 最終レビュー指摘の修正（下記） | [done] 2026-08-01 `1714e50` |
| A4 | 旧 2 ペインレイアウトの死にコード除去 | [done] 2026-08-02 `357bca7` |
| A5 | レールにフォルダツリーを追加 | [done] 2026-08-02 `ee97e7c` |
| A6 | 実機の見た目確認（ユーザー実施） | [done] 2026-08-02 レール・ツリー・余白とも OK |

検証: `npx tsc --noEmit` 通過、ui vitest 486 件パス（着手前 476 件）。

#### レールの構成（A5 時点）

`ArtifactsQuickAccess`（Pinned / Projects / Recent、自然高さ・詰まったら自前スクロール）+
[`ArtifactsFolderTree`](../../ui/src/artifacts/components/ArtifactsFolderTree.tsx)（残りを占有してスクロール）。

- ツリーは**フォルダのみ**描画する。ファイルはディレクトリペインの担当。
- 展開状態はツリーのローカル state。ページの `collapsedFolders` は
  `collectVisibleSelectableItemIds`（ctrl/shift の範囲選択）が使うため**共有しない**。
- `currentFolderPath` の祖先は navigation のたびに**マージ**する（置換しない）ので、
  手で開いたフォルダは畳まれない。
- 編集中にフォルダを選んだら `returnToDirectoryView()` を通す。通さないと選んだフォルダが
  エディタの裏に隠れ、クリックが効いていないように見える（枠の検索が編集モードで inert だったのと同種）。
- レールは `overflow: hidden` なので、中の 2 セクションは必ず自前でスクロールできること。
  Pinned は**件数上限が無い**（Projects は 8 件上限）ため、固定高セクションにすると
  ピンとツリーの両方が黙って切られる。

未実装: レールへのドラッグ&ドロップ（ディレクトリペインは対応済み）。

#### 実装中に確定した判断

- **枠の検索・プロジェクト選択は編集モードで消す**。検索結果はディレクトリペイン内
  （`hasActiveSearchQuery` 分岐）でしか描画されないため、artifact を開いている間は入力しても
  何も起きない。`va-toolbar` 自体が `hasDetailSelection` で丸ごと隠れる既存設計に合わせた。
  レール開閉トグルはウィンドウレイアウトの操作なので編集中も残す。
- `/` ショートカットは `getArtifactsSearchShortcutAction` に切り出した。
  main = `expand`（従来どおり）、専用アプリのディレクトリ表示 = `focus`、編集モード = `ignore`。
  メイン側の挙動が変わっていないことは単体テストの真理値表で固定している。

#### 最終レビューで見つかった欠陥（A3 で修正済み）

- **レール 232px + アウトラインサイドバー 280px で、幅 512px 未満のウィンドウでは
  エディタが幅ゼロになり消える**。ウィンドウに最小幅は無くレールは既定で表示なので、
  ウィンドウを細めて artifact を開くだけで踏める。`body.workbench-artifacts-edit-mode` を使い、
  **編集中かつ 900px 以下のときだけ**レールを退避させる（ディレクトリ表示は全幅で維持）。
- レールの localStorage ヘルパが素の `localStorage` を叩いていた。この feature の他の設定
  （`utils/lastLocation.ts` / `utils/pins.ts`）は `storageAvailable()` + `try`/`catch` で守っている。
  読み取りは `/artifacts` のマウント毎（メインアプリ含む）に走るため、規約に合わせた。

#### 積み残し（この wave の範囲外）

- **`.variant-title-bar-slot` は折り返さないので、細いウィンドウでは枠のコントロールが
  ウィンドウボタンへはみ出す**（[`styles.css`](../../ui/src/styles.css) の `.variant-title-bar-slot`）。
  `.chrome-search` は `clamp(140px, 24vw, 300px)` で 140px の下限を持つ。
  これは Artifacts 固有ではなく共通シェルの問題で、コントロール数がより多い Notes の方が先に破綻する。
  3 アプリ全部に影響するため独立して直す。

## P2-6 の仕様

Workbench のセッションは `id` / `username` / `createdAt` のみでメールアドレスを持たないため、
MS To Do の「名前 + メール」に相当する 2 行目は**接続先サーバーのホスト名**とした。
複数サーバーを渡り歩く設計上、この文脈で最も意味のある情報のため。

### 実装中に判明した罠

- **`data_directory` は全ウィンドウに適用しないと破綻する**。Tauri は WebContext をデータディレクトリで
  キーイングする（`tauri-runtime-wry-2.10.1/src/lib.rs:4601`）ため、一部のウィンドウだけに設定すると
  Quick Note などが別ストレージへ分離する。[`window.rs`](../../native/desktop/src-tauri/src/window.rs) の
  `with_shared_data_directory` を全ビルダーに通すこと。
- **SVG の gradient は `userSpaceOnUse` にする**。既定の `objectBoundingBox` 単位だと、水平・垂直の
  直線パスはバウンディングボックスが潰れて **stroke が描画されない**。アイコンの主マークが
  消える形で踏んだ。

### P2-3b で解く必要がある課題

専用アプリからヘッダーを削除したため、**設定・ログアウト・サーバー URL 変更への UI 導線が無い**。
P2-1 でメインと設定を共有するため通常運用では問題にならないが、専用アプリのみを単独インストールした
場合に詰む。各機能ページのツールバー内に控えめなアプリメニューを置く方針とする。

## 既知の注意点

- `native/desktop/src-tauri/tauri.conf.json` は **`.gitignore` されている生成物**。したがって
  「生成後に `git diff` が空であること」は検証として無意味（常に空になる）。内容の検証は
  生成された JSON を直接読むこと。
- `build:native:all` は最後の variant の config を残すため、完了時に main の config を再生成して
  作業ツリーを既定状態へ戻す（[`build-variants.mjs`](../../native/desktop/scripts/build-variants.mjs)）。
- 稼働中の `workbench-sync-daemon.exe` が `target/debug` のサイドカーをロックするため、
  アプリ起動中の `cargo test` / `cargo check` は tauri-build が `PermissionDenied` で panic する。
  隔離した `CARGO_TARGET_DIR` を使う。

---

# Phase 3: native UI を web から完全独立させる（2026-08-02）

Phase 2 までは native と web が `ui/` を共有していた。ユーザー判断により、**native と web の TS コードを
完全に分離**し、以後それぞれの環境に最適化して分岐させる。

## 決定事項（ユーザー指示）

1. **native と web の TS コードを完全独立にする**。使える部分はコピーして使い、以後は環境最適化を優先する。
2. **UI の DLL 化・ネイティブ描画への移行はしない**。これまでどおり TS で書く（レイアウトはスクリプト優位）。
3. **URL クエリ（`?app=<variant>`）をやめ、variant は Rust から直接渡す**。
4. fork の範囲は **main アプリを含む全体**（`ui/src` 225 ファイル / 約 59,000 行）。
5. fork 後、**web 側の `ui/` から variant 専用コードを剥がす**。

## 背景: なぜ `?app=` が問題なのか

variant の権威は **Rust 側**にある（[`variant.rs`](../../native/desktop/src-tauri/src/variant.rs) が
`app.config().identifier` から導出）。それを `?app=artifacts` という文字列に落として URL 経由で JS へ渡し、
JS が読み直している（[`window.rs`](../../native/desktop/src-tauri/src/window.rs) の `app_url` 組み立て →
[`App.tsx`](../../ui/src/App.tsx) の `resolveVariantStartPage`）。**既に知っている事実の往復**であり、
かつその往復路は URL クエリなので **web からも `https://<host>/?app=artifacts` で到達できてしまう**。

到達した先の専用シェルには responsive ルールが 1 件も無く（`styles.css` の `@media` 内に `.variant-*` は 0 件）、
タイトルバーのボタンは `window.__TAURI_INTERNALS__` を叩くため web では例外になる。
つまり**最初から web 非対応の画面が web から開ける**状態だった。

### 誤解しやすい点（記録）

`frontendDist` の中身は **Tauri がバイナリに埋め込む**。`ui/dist` は `.gitignore` 済みの生成物であり、
実行時に web サーバから UI を取得しているわけではない。`http://tauri.localhost/...` は
埋め込みアセットに対する WebView2 内部のアドレッシングであって、ネットワーク上の住所ではない。
「UI を実行ファイルに埋め込む」は既に満たされている。

## Wave 分割

### N1: variant を Rust から注入し `?app=` を廃止

- `window.rs`: 各ウィンドウビルダーに `initialization_script` を付け、ページ読み込み前に
  `window.__WORKBENCH_VARIANT__` を同期注入する
  （`tauri-2.10.3/src/webview/webview_window.rs:946`。doc の例が文字どおりこの用途）。
- App URL は全 variant で `index.html` に戻る。訂正1（`?app=` でないと NotFound になる問題）は
  **クエリを使わなくなることで消滅する**。
- `App.tsx`: `resolveVariantStartPage(window.location.search)` → 注入値を読む形へ。
- ウィンドウ固有のパラメータ（`note=<id>`、`quick-note-window=1`）は**アプリ同一性ではなく
  そのウィンドウのデータ**なので URL のまま残す。
- 検証: `cargo test`、`npx tsc --noEmit`、ui vitest。

### N2: `ui/` を `native/desktop/ui/` へ fork

- 新 workspace `native/desktop/ui`（ルート `package.json` の `workspaces` に追加）。
- `NATIVE_FRONTEND_DIST`: `../../../ui/dist` → `../ui/dist`（`src-tauri` からの相対）。
- `NATIVE_DEV_URL`: web の dev サーバ（5174）ではなく native 専用ポートへ。
  [`workbench-env.mjs`](../../infra/scripts/workbench-env.mjs) が `uiDevUrl` を流用しているため要変更。
- ルートスクリプト: `build:native` / `build:native:all` / `dev:native` を native UI 側へ向ける。
  `build:web` と `dev:web` は `ui` のまま。
- `services/workbench-core` が web に配信するのは従来どおり `ui/dist`。

### N3: web 側の variant 専用コードを剥がす

- `VariantShell` / `VariantTitleBar` / `VariantChrome` / `VariantAccountBar` と
  `App.tsx` の `?app=` 分岐、`resolveVariantStartPage`。
- Phase 2 で各ページに入れた専用アプリ分岐（Artifacts のレール・フォルダツリー・title bar portal、
  Notes の `NotesAppView`）も web からは除去する。
- これにより「web から `?app=` に到達できる」問題が根本から消える。

### N4: native 側の環境最適化（別計画）

fork 完了後に着手。Phase 2 の残作業（Tasks のフォルダベース化、Notes 複数選択、
タイトルバーの折り返し）は **native 側の計画として引き継ぐ**。

## リスクと許容

- **約 59,000 行が二重化する**。以後 web の修正は native に自動で入らない。これは
  「環境最適化を優先する」という決定の裏返しとして**意図的に受け入れる**。
- テストスイートが 2 系統になる（現在 ui vitest 486 件）。
- 共通のつもりだった `lib/api` も分岐する。Core の API 変更時は両方の追従が必要。

## Phase 3 進捗ボード

| Wave | 内容 | 状態 |
|---|---|---|
| N1 | variant を Rust から注入し `?app=` 廃止 | [done] 2026-08-02 `782af0c` |
| N2 | `ui/` を `native/desktop/ui/` へ fork | [done] 2026-08-02 `33dbe92` |
| N3 | web 側から variant 専用コードを除去 | [done] 2026-08-02 `378e295` |
| N4 | native 側の環境最適化 | [pending] 別計画 |

### N1 の実装メモ

- 注入は `with_window_defaults`（旧 `with_shared_data_directory`）で行う。**全ウィンドウビルダーが
  通る唯一の choke point** であり、data_directory と同じく「1 つでも漏れると壊れる」不変条件のため
  同じ場所に置いた。漏れたウィンドウは variant を持たず main アプリとして描画される。
- App URL は全 variant で `index.html` に戻った。これにより Phase 1 の**訂正1（`index.html?app=` が
  NotFound になる問題）は前提ごと消滅**した。
- web には注入が無い → `window.__WORKBENCH_VARIANT__` が `undefined` → `resolveVariantStartPage` が
  null → 通常の `Layout`。**N3 を待たずに「web から専用シェルへ到達できる」問題は塞がった**。
- `open_calendar_window` / `open_new_app_window` は外部 URL を開くことがあり、そこにも
  initialization script が入る。variant 名は機微情報ではないため許容。
  （これらのウィンドウが WebView2 データディレクトリを外部オリジンと共有するのは P2-6 由来の既存挙動。）

### 判明した死にコード（未処理）

`openVariantWindow`（[`ui/src/lib/api.ts`](../../ui/src/lib/api.ts)）と
`standaloneNoteUrl`（[`NotesAppView.tsx`](../../ui/src/notes/NotesAppView.tsx)）は
**エクスポートされテストもあるが、production コードからは一度も呼ばれていない**。
Rust 側の `open_variant_window` コマンドも同様に到達不能。
P2-3b で「新ウィンドウが空白になり Quick Note 再利用に切り替えた」際の残骸。
N1 では削除せず追従のみ行った。撤去するなら N3 / N4 の掃除に含める。

### N2 / N3 の実装メモ

- fork 直後の `native/desktop/ui/src` は `ui/src` と**バイト一致**（`diff -r` で確認）。分岐は N4 以降。
- dev サーバは web 5174 / native 5175。`workbench-env.mjs` が両方の `.env` を生成する。
  **native のポートは 5175 をハードコード**しているため、`UI_DEV_PORT=5175` に変えると衝突する。
- `npm install` が `node_modules/insights` の stale link を落とした。`services/insights` は
  analyser 移行で消えており、lock だけが実在しないディレクトリを指していた。
- N3 で `ArtifactsQuickAccess` は**残す**。dedicated app 作業中に `Layout` から切り出したが、
  web のサイドバーが `/artifacts` で描画しているため web のコードである。
- N3 後: web = 452 テスト（variant 系 34 件削除）、native = 486 テスト。

### N3 で踏んだ Codex タイムアウトの実例

30 分の MCP タイムアウト後、**孤児プロセスが 5 分近く書き続けた**。
最初の監視（無変更 60 秒で安定と判定）では `styles.css` を取りこぼし、
安定判定の直後に書き込まれた。**60 秒の静止は安定の証拠にならない**。
今回は 180 秒静止で確定した。孤児が作業中に自分で同じファイルを編集すると
上書きされて消えるため、**待つ方が安全**。

### N2 の罠: workspace をパスで指すと配下も巻き込む

`native/desktop/ui` を `native/desktop/` の**内側**に置いたため、npm の
`--workspace native/desktop` が**配下の全 workspace にマッチ**するようになった。
variant ビルドは Rust をビルドし終えた直後に `native-ui` に対しても `tauri:build` を流し、
`Missing script` で停止する。**パスではなくパッケージ名で指すこと**
（`workbench-native-desktop` / `native-ui`）。修正は `1e302a6`。

確認方法: `npm run --workspace native/desktop` を引数なしで実行すると、
マッチした全 workspace のスクリプト一覧が出る。2 つ出たら曖昧。

型チェック・両方のテスト・`prepare-tauri-config` の出力はすべて通っていたため、
**`tauri build` を実際に走らせるまで検出できなかった**。workspace 構成を変える変更では、
遅くてもバンドルまで通すこと。

### 4 本ビルドの実績（2026-08-02）

`npm run build:native:all` 成功。variant 3 本を `target/release/variants/` へ退避（各 9.5MB）し、
main のバンドル時に NSIS テンプレートが `Section /o` で取り込む
（[`installer.nsi:724-739`](../../native/desktop/src-tauri/nsis/installer.nsi)）。
最終成果物は `Workbench Native_0.1.0_x64-setup.exe` 1 本（30MB、コンポーネント選択つき）。

### 実機確認の結果（2026-08-02）

インストーラ 1 本を実機導入して確認。

| 項目 | 結果 |
|---|---|
| コンポーネント選択・タスクバー個別ピン留め | OK |
| **専用アプリが `?app=` なしで正しい機能に着地** | OK（N1 の中核を実機で確認） |
| Artifacts のレール・フォルダツリー・余白 | OK |
| daemon が単一 | 起動して 1 つ。ただし下記の限定つき |

#### daemon 単一性の検証範囲（重要）

`autoStart` は **main のみ true**、tasks / notes は false、artifacts は未設定だった。
したがって観測された「1 つ」は **main だけが spawn した結果**であり、
**Wave 3 のプロセス横断ガード（同時 spawn の防止）は実機では踏んでいない**。
ガードを実際に検証するには複数アプリで `autoStart` を有効にし、同時起動する必要がある。
単体テスト（`daemon_guard::tests`）はロック競合と再取得を押さえている。

daemon の実ポートは 35780（`DEFAULT_DAEMON_HTTP_PORT`）。数えるコマンド:
`Get-Process workbench-sync-daemon | Measure-Object | Select-Object Count`

#### 見つかった不具合: トレイの「Open sync daemon log」が何も開かない（修正済み `24bff6c`）

`.log` は Windows 標準では**関連付けが無い**（`assoc .log` が「見つかりません」）。
`open_with_default_app` の `cmd /C start "" <path>` は起動対象を見つけられず即終了し、
ユーザーには**コンソールが一瞬光って消える**だけに見えていた。
アプリが書いたテキストは Notepad で開くようにし（`open_text_file`）、
ユーザーが選んだファイルは従来どおり既定アプリへ。

併せて `open_with_default_app` に `CREATE_NO_WINDOW` を追加。P2-5 で daemon 本体には
付けたがこちらは漏れており、**ファイルを開くたびにコンソールが明滅**していた。

#### 仕様であって不具合ではないもの

設定画面の「Local daemon status is not loaded.」は、マウント時に読むのが
`readPreferences` だけで status は `refreshLocalDaemon` 経由でしか読まないため
（[`useLocalDaemonSettings.ts:46-73`](../../native/desktop/ui/src/settings/hooks/useLocalDaemonSettings.ts)）。
Refresh を押すまでは空。開いた瞬間は壊れて見えるので、
マウント時に 1 回読むかどうかは UX の判断事項として残す。

## 設定の共有（2026-08-02 決定・Phase 1 の制約を撤回）

Phase 1 は `daemon-preferences.json` が variant ごとに分かれることを許容していたが、
**設定は 1 つの共有 daemon を記述するもの**なので分割は一貫していない。実際、
main だけ `autoStart: true`、tasks / notes は `false` という状態が生まれ、
「daemon が 1 つ」の観測が**ガードが効いた結果なのか main しか起動していないだけなのか
区別できなくなった**（実機確認の限界の原因）。

Tauri は `app_config_dir()` を bundle identifier から導出するため、
[`variant.rs`](../../native/desktop/src-tauri/src/variant.rs) に `shared_config_dir_from` を置き、
**末尾のコンポーネントだけを main の identifier に差し替える**。`%APPDATA%` を焼き込まないので
プラットフォームに依らない。P2-1 の `shared_webview_data_directory` と同じ考え方。

対象は `app_config_dir()` を使っていた 2 箇所のみ:

| ファイル | 効果 |
|---|---|
| `daemon-preferences.json` | 全アプリが同じ設定を読み書きする |
| `sync-daemon.log` | variant が起動した daemon のログも main のトレイから開ける |

**移行**: main の既存設定がそのまま正本になる（パスが変わらないため）。
`com.workbench.desktop.{tasks,notes,artifacts}` 配下の古い
`daemon-preferences.json` は参照されなくなる。削除は任意。

**副作用**: main が `autoStart: true` なので、次回以降は**全 variant が daemon を起動しようとする**。
Wave 3 のプロセス横断ガードが通常運用で常時踏まれることになる。

共有されていないもの（意図的）: single-instance のミューテックスは identifier ごと
（アプリごとに独立したインスタンスにするため）。
localStorage 由来の設定（サーバ URL / ショートカット / 起動ページ）は P2-1 で既に共有済み。
ログインセッションは Credential Manager の固定名で元から共有。

## Phase 3 の残課題

- **native と web が両方 486/452 テストを持つ二重保守**が始まった。Core の API 変更は両方に反映が要る。
- Phase 2 の残作業（Tasks のフォルダベース化、Notes 複数選択、タイトルバーの折り返し）は
  **native 側の課題として引き継ぐ**（`native/desktop/ui/` で実施）。
- web 側にはまだ Tauri 依存の分岐（`isTauriNativeRuntime` によるローカル daemon 設定など）が残る。
  「variant 専用コードの除去」の範囲外としたため、必要なら別途判断する。
- ~~実機確認は未実施~~ **2026-08-02 実施済み。上記「実機確認の結果」を参照**（`?app=` なしの着地、
  Artifacts のレール・フォルダツリーとも OK）。

---

# Phase 4: daemon を独立アプリにする（参照カウンタ導入・2026-08-02）

## 背景

Phase 1〜3 の所有権モデルは「spawn したプロセスが `Child` を持ち、そのプロセスだけが止められる」だった。
これが実機で 3 つの不具合を生んだ。

1. 所有者が終了すると、adopt した他アプリの足元で daemon が死ぬ
2. 所有者以外は Stop できない（UI のボタンが効かない）
3. 生存判定が壊れていた間、複数 daemon が起動し後発が EADDRINUSE で死んでいた

根本は「独立プロセスなのに、依存関係を持つ他アプリのことを誰も知らない」点にある。
**daemon を独立アプリとして扱い、誰が依存しているかを daemon 自身に持たせる。**

## 方式の選定

ユーザー案は「共有メモリ + 名前付きミューテックス + IPC」。採用しないのは次の理由。

- **クラッシュ耐性が本質的な難所**。共有カウンタは「減算せずに死んだアプリ」の始末が難しく、
  結局 PID を持たせて生存確認する = TTL を自前で再実装することになる。
- **権威は daemon 側にあるべき**。どのクライアントからも壊せる共有整数は「独立アプリ化」の逆。
- **経路が既にあり認証済み**。loopback HTTP + `x-workbench-daemon-token`。
  新しいプリミティブも Windows 固有コードも増えない（daemon は Node）。
- **観測できる**。`GET /leases` で「誰が生かしているか」が答えられる。

名前付きミューテックスが正しいのは **spawn 競合の解決だけ**（daemon がまだ居ない時点の問題のため）。
そこは Phase 4 とは独立に `f51ed71` で修正済み。

## 確定仕様

### daemon 側（TS）

- `POST /leases {clientId, variant, pid}` — 登録・更新。`{ttlMs, heartbeatMs}` を返す
- `DELETE /leases/{clientId}` — 解放
- `GET /leases` — 一覧（診断用）
- 掃除: 10 秒間隔。TTL（90 秒）超過のリースを破棄 → **アプリがクラッシュしても漏れない**
- **既定は常駐**。リースが空でも終了しない
- `exitWhenIdle` が有効なときのみ、空のまま猶予（60 秒）経過で自ら終了。
  猶予はアプリ再起動中の巻き添えを防ぐ
- `POST /shutdown` — 明示終了。**所有者でなくても止められる**
- SIGTERM / SIGINT で後片付け（現状は皆無で、アプリは `taskkill /F` に頼っている）

### アプリ側（Rust）

- レディネス確認後に `POST /leases`。clientId は `{variant}-{pid}`
- 30 秒間隔でハートビート
- 終了時は `DELETE /leases/{id}` のみ。**kill しない**
- `stop_daemon` は `POST /shutdown` に置き換え、所有していなくても効くようにする
  （所有している場合のフォールバックとして kill は残す）

### 設定

`exitWhenIdle` を Settings から切り替え可能にする。**既定は常駐（false）**。
バックグラウンド同期を続けたい運用があるため、アプリ全終了で必ず落とすのは選択制とする。

## Wave 分割

| Wave | 内容 | 状態 |
|---|---|---|
| D1 | 起動ガードの修正（ミューテックス待機 ≥ レディネス待ち、取得失敗時は spawn しない）+ `stop_daemon` の所有権保持 | [done] 2026-08-02 `f51ed71` |
| D2 | daemon 側のリース登録簿 + graceful shutdown + `exitWhenIdle` | [done] 2026-08-02 `893947e` |
| D3 | アプリ側のリース取得・ハートビート・解放、`stop_daemon` の置き換え | [done] 2026-08-02 |
| D4 | Settings に `exitWhenIdle` トグル | [done] 2026-08-02 |

## レビュー指摘のうち Phase 4 で解消するもの

独立レビュー（2026-08-02, read-only）の指摘との対応。

| 指摘 | 対応 |
|---|---|
| 所有者終了で adopt 側の daemon が死ぬ | D3（kill をやめる） |
| ミューテックス待機 10s < レディネス 20s、取得失敗を無視 | **D1 済み** |
| `stop_daemon` がエラー時に所有権を捨てる | **D1 済み** |
| 所有権フラグが `owned` でなく `nativeOwned`、UI 未表示 | D3 で整理（リース一覧に置き換わるため） |
| トークン再生成時に webview が古い値を持つ | D3 で扱う |
| 設定ファイルの lost update（複数プロセスの read-modify-write） | **未対応**。共有化で顕在化した構造問題。別途 |
| loopback probe の全体締切が無い（read ごとのタイムアウトのみ） | **未対応**。実害は限定的だが残課題 |

## D2 実装メモ

- リース登録簿は **daemon プロセス内メモリ**（[`services/sync-daemon/src/leases.ts`](../../services/sync-daemon/src/leases.ts)）。
  サーバへは一切送らない。API も daemon 自身のループバック HTTP に生やした。
- テストは時計を引数で受ける設計にし、失効・猶予のルールを sleep せず検証する。
  daemon のテストは `tsx --test src/__tests__/**/*.test.ts` で、**glob が `src/__tests__/**` のみ**という
  既知の罠があるためそこに置いた。147 → 160 件。
- `DaemonState.leases` を必須にしたため既存フィクスチャ 5 件に 1 行ずつ追加。
  `exitWhenIdle` は既存の `allowAnonymousApi` に倣い任意とし、フィクスチャ側の変更を不要にした。
- **D3 未了のため、このルートを呼ぶものはまだ無い。** `exitWhenIdle` も既定 off なので、
  現時点の実効挙動は D2 以前と同じ（アプリは終了時に依然 daemon を kill する）。

## 予約作業: `services/sync-daemon` の配置見直し

`services/` に**サーバ配備のドメインサービス**と**クライアント同梱の sidecar** が同居しており、
名前から区別がつかない。実際にこれが誤解を生んだ（「なぜサービス側がリースを持つのか」）。

2026-08-02 は **(A) ドキュメントで明記**のみ実施（README の「Services and default ports」節、
CLAUDE.md の構成節）。**(B) `native/sync-daemon/` などへの移動は予約**。

移動時に追従が要るもの:

- ルート `package.json` の workspace glob `services/*`
- `services/sync-daemon/scripts/build-tauri-sidecar.mjs` の出力パス
- Tauri の `externalBin`（現在 `../../../services/sync-daemon/dist/tauri-sidecar/workbench-sync-daemon`）
- `prepare-tauri-config.mjs` が読む sidecar マニフェストのパス

daemon のライフサイクル改修中にビルド経路を動かすと失敗の切り分けが難しくなるため、
**Phase 4 完了・実機確認後に着手すること**。

---

# 想定アーキテクチャとの食い違い → 別計画へ

トレイ常駐・グローバルショートカットの主体は、本来 main ではなく **daemon** であるべき、という
食い違いが 2026-08-02 に判明した。variant 分割とは独立した改修のため、別計画に切り出した。

**→ [workbench-native-daemon-residency-plan.md](workbench-native-daemon-residency-plan.md)**

本計画への影響は 1 点。`exitWhenIdle` の「使用中」の定義を、役割が反転していない現状に合わせて
**(b)「プロセスが生きていれば使用中」で暫定確定**した（現在の実装がそのまま該当）。
反転が済んだら (a)「ウィンドウを持たない常駐アプリはリースを手放す」へ戻す。理由は別計画に記載。
