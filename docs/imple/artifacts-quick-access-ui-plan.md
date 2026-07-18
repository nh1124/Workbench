# Artifacts Quick Access UI Plan (2026-07)

Status: 実装完了(2026-07-18)。受入は Owner 実機確認待ち
Last updated: 2026-07-18

Owner 課題(2026-07-17): Artifacts は高頻度で使うが、目的ファイル・新規作成に
到達するまでのクリック数が多く、急ぐときは notes で代用してしまう。
「開く」「作る」への到達コストを下げる。

Status legend は maintenance-loop-plan §1 と同一。状態更新は root agent のみ。

## 0. 現状実装の把握

- サイドバー: [Layout.tsx:104-116](../../ui/src/components/Layout.tsx#L104-L116) の
  フラットな NavLink 一覧。Artifacts は `/artifacts` への単一リンクで階層なし。
- ArtifactsPage: [ArtifactsPage.tsx](../../ui/src/pages/ArtifactsPage.tsx)(約3150行)。
  状態(projectFilter / selectedFolderPath / selectedItemId / viewMode 等)は
  すべてコンポーネントローカル → 他ページへ遷移すると unmount で全消失。
  復元手段は `?item=<id>` クエリのみ(UX-2 で実装済み)。
- 初期表示: `projectFilter=""`(All)で全プロジェクトの tree をマージした
  root ディレクトリを表示。project の切替はツールバーの `<select>`。
- tree は `artifactsApi.tree(projectId?)` で全件クライアントロード済み
  ([api.ts:1100](../../ui/src/lib/api.ts#L1100))。検索 UI・検索 API はどちらも無い。
- Recents: [recents.ts](../../ui/src/artifacts/utils/recents.ts) が item open 時に
  localStorage へ最新20件記録(UX-2)。ただし利用は HomePage のみで、
  Artifacts UI 内からは見えない。
- Pin 機構: artifacts には存在しない(tasks のみ)。
- 新規ノート作成の現行動線: サイドバー Artifacts → (フォルダ移動 ×n) →
  `+ New Note` → タイトル/パス編集 → Save。project 指定はフィルタ select 経由で
  さらに 2 操作。ページ内ショートカット Ctrl+N はあるがページ到達後のみ有効。

## 1. 設計方針

- 基盤は「Artifacts の表示状態の URL 化」(P1)。project / folder を URL クエリに
  持たせることで、サイドバーからの直リンク(P2)・最終ページ復元(P5)・
  ブラウザ履歴/新規ウィンドウがすべて同じ仕組みに乗る。
  グローバルストア(zustand 等)の新規導入はしない。
- backend 変更なし。検索はクライアント側フィルタ(tree 全件ロード済みのため)、
  pin / recents / last-URL は localStorage(recents.ts と同パターン)。

## 2. 施策

### P1: URL 駆動の状態化(基盤)

- `/artifacts?project=<id>&folder=<path>&item=<id>` を正とし、
  projectFilter / selectedFolderPath / selectedItemId の変更を
  `useSearchParams` で URL に反映・URL から復元する(replace で履歴汚染しない)。
- 既存の `?item=` 挙動は互換維持。

### P2: サイドバー Artifacts 2段階層

- `/artifacts` ルート表示中(判定は既存 `isArtifactsRoute`)、サイドバーの
  Artifacts 直下にサブパネルを展開する:
  1. **Pinned** — pin 済み folder / item(localStorage
     `workbench.pinnedArtifacts`、recents.ts と同スキーマ+kind:"folder")。
  2. **Projects** — projectOptions 一覧。クリックで
     `/artifacts?project=<id>` へ。行 hover に「+ New Note」アイコンを置き、
     1クリックで該当 project root に新規ノート下書きを開く。
  3. **Recent** — readRecentArtifacts() 直近5件。クリックで `?item=<id>`。
- pin 追加/解除は Artifacts 内の既存コンテキストメニューに「Pin / Unpin」を追加。
- project 一覧の取得は ArtifactsPage の loadProjects と重複するため、
  取得ロジックを `useArtifactProjects` フックへ抽出して共用する。
- サイドバー collapsed / compact(モバイル)時はサブパネル非表示(従来リンク動作)。
- Owner フィードバック(2026-07-18)による変更: 入れ子のサブパネルではなく、
  サイドバー全体が横スライド(約200ms、reduced-motion 対応)で Artifacts 専用
  メニュー(戻るボタン + Quick access)に切り替わる方式。戻るボタンは
  /artifacts に留まったままメインメニューへ戻る。

### P3: 初期表示を project 一覧に

- `project` クエリ未指定かつ folder / item 未指定のとき、root ディレクトリの
  代わりに project カード一覧(名称・item数・最終更新)を表示する。
  クリックで `?project=<id>` の root へ。
- 従来の「All で横断表示」はカード一覧先頭の「All Projects」カードで残す。

### P4: 検索(クライアントフィルタ)

- ツールバーに検索アイコンを追加。クリック(または `/` キー)で入力欄を展開し、
  ロード済み items を title / path / tags で部分一致フィルタ、
  フラット一覧(パス付き)で表示。Enter/クリックで item open。
- project フィルタと AND で効く。サーバー側全文検索は将来スコープ(範囲外)。

### P5: 最終表示ページの復元

- ArtifactsPage 側で現在の URL(query 含む)を localStorage
  `workbench.artifacts.lastLocation` に保存。
- サイドバーの Artifacts リンク(および P2 パネルのヘッダ)クリック時、
  保存済み location があればそこへ遷移。無ければ `/artifacts`(=P3 の一覧)。
- 明示的に project 一覧へ戻る導線はツールバーの Home ボタン(既存)を流用。

## 3. クリック数の変化(目安)

| 操作 | 現状 | 提案後 |
|---|---|---|
| 特定 project に新規ノート | Artifacts → select 2操作 → New Note = 4+ | サイドバー project 行の + = 1〜2 |
| よく使う folder を開く | Artifacts → フォルダ辿り ×n | Pinned から 1 |
| 直前の作業に戻る | Artifacts → 辿り直し | Artifacts クリックのみ(復元) |
| ファイル名で探す | 目視でフォルダ辿り | 検索アイコン → 入力 |

## 4. 実装順序と分担

P1 → P2 → P5 → P3 → P4 の順(P2/P5 が P1 に依存。P3/P4 は独立)。
worker: codex(MCP)。レビュー・commit: root agent。

## F1: D&D アップロード保存先の修正(2026-07-18 Owner 報告)

症状: D&D 保存したファイルが画面に表示されず Recent からしか辿れない。
原因: 背景ドロップが常に root 直下(`handleRootDrop` → ROOT_DROP_PATH)へ、
プロジェクト未選択時は default プロジェクトへ保存され、P3 のカード一覧化で
root が初期表示から隠れたため顕在化。

- F1-1: 背景(フォルダ行以外)への OS ファイルドロップは `currentFolderPath` へ
  保存(アップロードボタンと対称)。item の move も背景ドロップは現在フォルダへ。
- F1-2: カード一覧表示中はプロジェクトカードへのドロップでそのプロジェクトの
  root へ保存。背景へのドロップは受け付けない。
- F1-3: アップロード完了後、保存先の project / folder を URL・状態に同期し、
  詳細表示を閉じてもファイルの場所が表示されるようにする。

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| P1-1 | `[implemented]` | ui | project/folder/item の URL クエリ化 + 復元(既存 ?item= 互換) |
| P2-1 | `[implemented]` | ui | useArtifactProjects フック抽出(loadProjects 共用化) |
| P2-2 | `[implemented]` | ui | サイドバー Artifacts サブパネル(Pinned / Projects / Recent) |
| P2-3 | `[implemented]` | ui | pin の localStorage 管理 + コンテキストメニュー Pin/Unpin |
| P2-4 | `[implemented]` | ui | project 行 hover の + New Note(1クリック新規下書き) |
| P3-1 | `[implemented]` | ui | project 未指定時の project カード一覧表示(All カード含む) |
| P4-1 | `[implemented]` | ui | 検索アイコン + クライアントフィルタ(title/path/tags、`/` キー) |
| P5-1 | `[implemented]` | ui | last location 保存 + Artifacts ナビの復元遷移 |
| P-R | `[implemented]` | root | レビュー・検証・commit |
| F1-1 | `[implemented]` | ui | 背景ドロップを currentFolderPath へ(upload/move とも) |
| F1-2 | `[implemented]` | ui | カード一覧: 背景ドロップ無効化 + プロジェクトカードへのドロップ対応 |
| F1-3 | `[implemented]` | ui | アップロード後に保存先 project/folder を URL・状態へ同期 |

## 受入

1. サイドバーで Artifacts を開くと Pinned / Projects / Recent が見え、
   project 行の + から 2 クリック以内で該当 project に新規ノート編集が始まる。
2. Artifacts 初期表示(project 未指定)が project カード一覧である。
3. 検索アイコンから入力した文字列で item がフィルタされ、クリックで開ける。
4. 他ツールへ移動して Artifacts に戻ると、最後に表示していた
   project / folder / item が復元されている。
5. `?item=<id>` 直リンク・Open in New Window の既存挙動が壊れていない。
