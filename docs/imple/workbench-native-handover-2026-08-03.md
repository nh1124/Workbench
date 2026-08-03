# 引き継ぎ: Workbench Native（2026-08-03）

セッションが長くなったため作成。**次にやるのは daemon 常駐の反転**。

## 次セッション開始プロンプト

```
docs/imple/workbench-native-handover-2026-08-03.md を読んで作業を引き継いでください。
次の作業は docs/imple/workbench-native-daemon-residency-plan.md の R0（実装言語・構成の決定）です。
```

## いま何が終わっているか

**variant 分割（Tasks / Notes / Artifacts の専用アプリ化）は完了し、実機確認も済んでいる。**
正本は [workbench-native-variant-apps-plan.md](workbench-native-variant-apps-plan.md) の冒頭「現状インデックス」。

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | variant 化の基盤（別 exe / ビルド / ルーティング） | 完了・実機確認済み |
| 2 | 見た目・導線・インストーラの作り込み | 完了・実機確認済み |
| 3 | native UI を web から完全独立（`native/desktop/ui/` へ fork） | 完了 |
| 4 | daemon の参照カウンタ（リース） | 完了・実機確認済み |

## 次にやること

**[workbench-native-daemon-residency-plan.md](workbench-native-daemon-residency-plan.md) の R0 から。**

トレイ常駐とグローバルショートカットの主体を **main から daemon へ反転**する。
ユーザーの想定は「daemon = 常駐サービス、アプリ = 出入りするクライアント」。現状は逆。

R0 は**実装言語・構成の決定**で、ここが最大の論点。daemon は現在 Node の sidecar なので、
Windows のトレイ UI とグローバルショートカットをどう持たせるかを決める必要がある。
計画書に選択肢 (1)〜(3) と現時点の見立て（二層構成）を書いてある。**着手前にユーザーと合意すること。**

daemon を `services/` 外へ移す予約作業は **2026-08-03 に実施済み**（`native/sync-daemon`）。
residency 計画の R0.5 を参照。

## 作業を始める前に知っておくべきこと

### アプリログがある（2026-08-03 追加）

トレイ →「Open app log」、実体は `%APPDATA%\com.workbench.desktop\workbench-native.log`。

**リリースビルドは windows-subsystem でコンソールが無く、`eprintln!` はどこにも出ない。**
これが無い間、不具合の原因を推測するしかなかった。webview の例外と未処理 Promise 拒否も同じファイルに入る。

**症状から 2 回推測して直らなければ、まずここを見ること。** 前回これを怠り、Quick Note の
不具合追跡に 6 ラウンド費やした。うち 1 回は推測が逆方向で、自分で新たな停止原因を作った。

### ウィンドウを開くコマンドは `async` にすること

Tauri の同期コマンドはメインスレッドで走る。ウィンドウ生成はイベントループの応答を待つので、
同期コマンドから呼ぶと自分が待っているループを自分で止め、`build()` が返らない。
症状は「空白のウィンドウが出て閉じられない」。詳細は variant 計画書の該当節。

### 実装体制

計画書は「Codex worker delegation」と書いてあるが、**2026-08 時点で Codex は 30 分タイムアウトで
空振りすることが多い**（1 バイトも書かずに終わる事例が複数）。実績としては Claude 直接実装が主。
委譲する場合はタイムアウト後の孤児プロセスによる遅延書き込みに注意（`git status` を commit 前に必ず確認）。

### スクリプトによる一括編集は避ける

`node -e` でのファイル一括編集が「成功」と出力しながら**何も書いていない**事例がこのセッションで
3 回あった（Panels の CSS が丸ごと欠落し、ビルド済み成果物を調べて初めて判明）。
CSS / TSX の挿入は Edit ツールで行い、結果を必ず内容で確認すること。

## ビルドと検証

```
npm run build:native:all
```

成果物は `native/desktop/src-tauri/target/release/bundle/nsis/Workbench Native_0.1.0_x64-setup.exe`
（1 本のインストーラにコンポーネント選択で 4 アプリが入る）。

検証コマンド:

```
cd native/desktop/src-tauri && CARGO_TARGET_DIR=<隔離パス> cargo test   # 24 件
cd native/desktop/ui && npx tsc --noEmit && node ../../../node_modules/vitest/vitest.mjs run   # 493 件
cd native/sync-daemon && npm test   # 160 件
cd ui && npx tsc --noEmit && node ../node_modules/vitest/vitest.mjs run   # 452 件（web）
```

`CARGO_TARGET_DIR` を隔離するのは、稼働中の daemon が `target` のサイドカーをロックして
`tauri-build` が `PermissionDenied` で panic するため。

## 未対応の既知課題

| 課題 | 扱い |
|---|---|
| `daemon-preferences.json` の lost update（複数プロセスの read-modify-write） | 設定共有で顕在化した構造問題 |
| loopback probe に全体締切が無い | 実害限定的 |
| `File item not found` / Sync issue | サーバ側 Artifacts の 404。variant 作業以前から存在。別件 |
| Panels の右クリックからの「新規ウィンドウ」 | list のみ実装。Panels はクリックで list へ渡す設計 |

## 関連ドキュメント

- [workbench-native-variant-apps-plan.md](workbench-native-variant-apps-plan.md) — 完了した作業の正本。冒頭に現状インデックス
- [workbench-native-daemon-residency-plan.md](workbench-native-daemon-residency-plan.md) — **次の作業**
- [README.md](README.md) — 計画書の索引（「ネイティブデスクトップ」節）
