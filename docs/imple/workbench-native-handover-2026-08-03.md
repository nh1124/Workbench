# 引き継ぎ: Workbench Native（更新 2026-08-04）

**R0〜R4 実装済み。R5（実機確認）は 8 項目中 7 項目が確認済み。
残るのは項目 8 の再確認だけ。**

## 次セッション開始プロンプト

```
docs/imple/workbench-native-handover-2026-08-03.md を読んで作業を引き継いでください。
次の作業は docs/imple/workbench-native-daemon-residency-plan.md の R5（実機確認）の残りです。
```

## R5 の残り

**再インストールしてから確認すること。**

| # | 内容 | 状態 |
|---|---|---|
| 8 | `exitWhenIdle` on で全ウィンドウを閉じ、daemon 終了 → 次の起動で復帰 | **修正済み・要再確認**。UI のラベルは「Stop Daemon When Idle」 |

**項目 8 を確認するときは `/status` を見ること。** 実行中の daemon の `exitWhenIdle` と
`leaseCount` が入っている。`leaseCount` が 0 にならないなら、ウィンドウを持たないアプリの
プロセスが残っている（app ログに `no windows are open; releasing the lease` が出る）。
リース解放は heartbeat 単位なので、最後のウィンドウを閉じてから最大 30 秒 + 猶予 60 秒。

確認済み: 1（インストール直後の起動）/ 2（再ログイン復帰）/ 3（ショートカット全 4 つ、
`Ctrl+Alt+C` の修正含む）/ 4（既存プロセスにウィンドウが増える）/ 5（トレイ各項目・
Quit でアプリも daemon も停止）/ 6（ショートカット変更の 2 秒反映）/ 7（最後のウィンドウで終了）
/ Quit 後のアプリ起動でトレイに resident が戻ること

## いま何が終わっているか

| 計画 | 状態 |
|---|---|
| [variant 分割](workbench-native-variant-apps-plan.md)（Tasks / Notes / Artifacts の専用アプリ化） | 完了・実機確認済み |
| [daemon 常駐の反転](workbench-native-daemon-residency-plan.md) R0〜R4 | **実装完了・実機未確認** |

**役割が反転した。resident が常駐サービス、アプリはクライアント。**

```
native/
  resident/    トレイ・グローバルショートカット・daemon の親。ログイン時に起動し常駐
  desktop/     Tauri アプリ。ユーザーが開いて閉じる
  sync-daemon/ 同期エンジン。resident の子プロセス
  shared/      両者が完全に一致していなければならないもの（Tauri 非依存）
```

構成の詳細と、なぜ `native/shared` を切ったかは
[residency 計画書](workbench-native-daemon-residency-plan.md)の「実装の構成」節にある。

## R5 の確認項目（全 8 件、元リスト）

インストーラ: `native/desktop/src-tauri/target/release/bundle/nsis/Workbench Native_0.1.0_x64-setup.exe`

**この改修で初めて動く経路**なので、ここを重点的に:

1. **インストール直後に resident が起動するか**（タスクトレイにアイコン）。
   インストーラが `Exec` で起動し、HKCU Run キーも書く。
2. **再ログイン後に resident が復帰するか**、そのとき daemon も立つか。
3. **グローバルショートカット**（`Ctrl+Shift+N` / `Win+Alt+N` / `Ctrl+Alt+N` / `Ctrl+Alt+C`）。
   アプリが 1 つも起動していない状態から押すのが本番。exe を起動する経路に変わった。
4. **アプリ起動中に同じショートカット**を押したとき、新プロセスではなく既存プロセスに
   ウィンドウが増えるか（single-instance の引数転送）。
5. **トレイメニュー**の各項目。特に「Start Workbench at login」のトグルと、
   「Quit Workbench」で daemon まで止まるか。
6. **設定画面でショートカットを変更**したとき、2 秒以内に resident 側へ反映されるか
   （`global-shortcuts.json` 経由・ポーリング）。
7. **最後のウィンドウを閉じるとアプリのプロセスが終了するか**（`residentMode` を撤去した）。
   トレイは resident のものなので残る。
8. `exitWhenIdle` を on にして全ウィンドウを閉じ、**60 秒後に daemon が終了**し、
   次にアプリを起動すると**起き直る**か。

**不具合を 2 回推測して直らなければ、まずアプリログを見ること**（下記）。
R5 で出た `Ctrl+Alt+C` の不具合は、**ログの 1 行で原因が確定した**（`invalid app window URL:
relative URL with a cannot-be-a-base base`）。症状からの推測では「Tasks を開いている時だけ動く」に
見えていて、実際は「何かウィンドウが開いている時だけ動く」だった。

## 作業を始める前に知っておくべきこと

### アプリログは resident の分も入る

トレイ →「Open app log」、実体は `%APPDATA%\com.workbench.desktop\workbench-native.log`。

**リリースビルドは windows-subsystem でコンソールが無く、`eprintln!` はどこにも出ない。
resident も同じ**なので、resident は `eprintln!` を一切使わず `workbench_shared::log` に書く。
行頭のタグ（`[resident]` / `[main]` / `[tasks]` …）でどのプロセスが書いたか分かる。
1 ファイルにまとめてあるのは、「ショートカットは発火したのか、アプリは起動したのか」が
プロセスをまたぐ問いだから。

前回これを怠り Quick Note の不具合追跡に 6 ラウンド費やした。うち 1 回は推測が逆方向だった。

### ウィンドウを開くコマンドは `async` にすること

Tauri の同期コマンドはメインスレッドで走る。ウィンドウ生成はイベントループの応答を待つので、
同期コマンドから呼ぶと自分が待っているループを自分で止め、`build()` が返らない。
症状は「空白のウィンドウが出て閉じられない」。詳細は variant 計画書の該当節。

### resident のメッセージループを塞がないこと

同じ形の罠が resident 側にもある。`daemon::start` / `daemon::stop` は loopback ポートを
**最大 20 秒待つ**。これをメッセージループ上で呼ぶと**トレイがその間まったく反応しない**。
実装時に一度やってしまい、`ensure_daemon_off_thread()` に分けた。
唯一の例外は Quit で、これは daemon が実際に落ちる前にプロセスが消えては困るため意図的に同期。

### スクリプトによる一括編集は避ける

`node -e` でのファイル一括編集が「成功」と出力しながら**何も書いていない**事例が 3 回あった。
今回のセッションでは Python も使えなかった。CSS / TSX / Rust の編集は Edit ツールで行うこと。

### 「ウィンドウが無いのに生きているアプリ」が実在する

Tauri が終了を決めるのは **ウィンドウの `Destroyed` がレジストリを空にした瞬間だけ**
（`tauri-runtime-wry/src/lib.rs` の `TaoWindowEvent::Destroyed`）。この経路を外れて
ウィンドウを失ったプロセスは生き残る。R5 で実際に、可視・不可視あわせてウィンドウを
1 つも持たない `workbench-native` がリースを更新し続けている状態を観測した。

**「プロセスが生きている＝ウィンドウがある」と仮定するコードを書かないこと。**
リースは heartbeat が毎回 `webview_windows()` を数えて決めている。

条件は未特定。その状態に入ったら app ログに
`no windows are open; releasing the lease` が出るので、次に遭遇したら報告すること。

### resident が「居るか」は名前付き mutex で判定する

`workbench_shared::resident::is_running()` は、resident の単一インスタンス用 mutex
（`Local\workbench-resident-instance`）が開けるかで判定する。プロセス名の列挙より確実で、
**resident 自身が二重起動を拒むのと同一の錠前**なので、両者の判断が食い違いようがない。
アプリ側はこれを見て、居なければ resident を起こす。

テストを書くときの注意: 開発機ではたいてい本物の resident がトレイに居る。「錠前が空いている」
前提のテストは実機で落ちるので、居る場合の分岐も書くこと。

### 実装体制

計画書は「Codex worker delegation」と書いてあるが、**2026-08 時点で Codex は 30 分タイムアウトで
空振りすることが多い**。実績としては Claude 直接実装が主。

## ビルドと検証

```
npm run build:native:all
```

成果物は `native/desktop/src-tauri/target/release/bundle/nsis/Workbench Native_0.1.0_x64-setup.exe`
（1 本のインストーラにコンポーネント選択で 4 アプリ + resident + daemon が入る）。

検証コマンド（2026-08-04 時点の件数）:

```
cd native/shared   && CARGO_TARGET_DIR=<隔離パス> cargo test   # 39 件
cd native/resident && CARGO_TARGET_DIR=<隔離パス> cargo test   # 18 件
cd native/desktop/src-tauri && CARGO_TARGET_DIR=<隔離パス> cargo test   # 23 件
cd native/desktop/ui && npx tsc --noEmit && node ../../../node_modules/vitest/vitest.mjs run   # 493 件
cd native/sync-daemon && npm test   # 160 件
cd ui && npx tsc --noEmit && node ../node_modules/vitest/vitest.mjs run   # 452 件（web）
```

`CARGO_TARGET_DIR` を隔離するのは、稼働中の daemon や resident が `target` の実行ファイルを
ロックして `tauri-build` が `PermissionDenied` で panic するため。
resident は**常駐が仕事なので必ず動いている**。`resident:build` はこれを検出して
何をすべきか出すようにしてある。

## 未対応の既知課題

| 課題 | 扱い |
|---|---|
| `daemon-preferences.json` の lost update（複数プロセスの read-modify-write） | 構造問題。resident は読むだけなので窓は狭まったが閉じてはいない |
| loopback probe に全体締切が無い | 実害限定的 |
| 設定画面の `(local GET /status): Connection failed: Failed to fetch` | `exitWhenIdle` on だとアプリ起動が daemon 起動と競走する。状態を一度しか読まないため出る。リロードで直る |
| `File item not found` / Sync issue | サーバ側 Artifacts の 404。variant 作業以前から存在。別件 |
| Panels の右クリックからの「新規ウィンドウ」 | list のみ実装。Panels はクリックで list へ渡す設計 |
| resident は Windows 前提 | トレイ・Run キー・メッセージループが `#[cfg(windows)]`。他 OS では起動しても何もしない |

## 関連ドキュメント

- [workbench-native-daemon-residency-plan.md](workbench-native-daemon-residency-plan.md) — **次の作業（R5）**。構成の正本
- [workbench-native-variant-apps-plan.md](workbench-native-variant-apps-plan.md) — variant 分割（完了）
- [README.md](README.md) — 計画書の索引（「ネイティブデスクトップ」節）
