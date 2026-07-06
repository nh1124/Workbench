# Workbench UX Refinements Plan (2026-07)

Status: 実装中
Last updated: 2026-07-07

Owner要望(2026-07-07)による小規模UX改善3件。maintenance-loop / capture-client とは独立。
Status legend は maintenance-loop-plan §1 と同一。状態更新は root agent のみ。

## UX-1: Maintenance ページの商用品質化

- ページ見出し下の説明文("Review memory, notes, briefs, and index drift across
  active Projects.")を削除する。
- 空状態("No maintenance items match the current filters.")は維持するが、
  商用製品水準の empty state に置き換える: アイコン + 短い見出し +
  一行の補足 + Refresh への導線を中央配置したカード。
- 全体レイアウトの整え: フィルタバーの余白/整列、totalsバッジの視覚統一、
  itemカードの密度・区切り・hover、既存デザイン言語(他ページのCSSトークン)の踏襲。
  新規UIライブラリは導入しない。

## UX-2: Home に Recent Artifacts ウィジェット

- 目的: 同じ project / artifact ページへ何度もクリックして辿る手間の削減。
- 記録: ArtifactsPage で item(note/file)を開いた時に localStorage へ
  `{ itemId, title, kind, path, projectId?, at }` を保存(最新順、上限20、重複はid去重)。
- 表示: Home に「Recent Artifacts」セクションを追加し直近8件を一覧表示。
  クリックで該当itemを開いた状態の Artifacts ページへ遷移する。
- 遷移先として Artifacts ページが `?item=<id>` クエリで指定itemを自動オープン
  できるようにする(UX-3のリンク先としても共用)。
- backend変更なし(サーバ側の閲覧履歴収集はしない。usage_eventsはMCP専用の計測)。

## UX-3: Artifacts item の別ウィンドウ表示 + MCPからの提示

- Artifacts の item 右クリックでコンテキストメニューを表示し、
  「Open in New Window」を追加する。
  - web: `window.open('/artifacts?item=<id>', '_blank')`
  - Tauri: native command で新規 WebviewWindow を開く(失敗時はwindow.openへfallback)。
- daemon MCP tool `workbench.local.artifact.open` を追加:
  input `{ artifactItemId }`。設定済みUI origin(`WORKBENCH_UI_ORIGIN`、
  default `http://localhost:5173`)の `/artifacts?item=<id>` URL を
  OS既定の方法(Windows: `start`)で開く。
  - origin は設定値に固定し、任意URLは開けない(コマンドインジェクション対策として
    URLはencodeURIComponentで構築し、shell解釈を避けて起動する)。
  - agentが編集したページをユーザーへ提示する用途。

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| UX-1-1 | `[pending]` | ui | Maintenance: desc削除 + empty state刷新 + レイアウト/密度/バッジ統一 |
| UX-2-1 | `[pending]` | ui | Artifacts閲覧のlocalStorage recents記録 + `?item=` 自動オープン |
| UX-2-2 | `[pending]` | ui | Home Recent Artifactsセクション |
| UX-3-1 | `[pending]` | ui | Artifactsコンテキストメニュー + Open in New Window(web/Tauri) |
| UX-3-2 | `[pending]` | native | Tauri 新規ウィンドウcommand |
| UX-3-3 | `[pending]` | daemon | MCP `workbench.local.artifact.open`(origin固定、encode徹底) |
| UX-R | `[pending]` | root | レビュー・検証・commit |

## 受入

1. Maintenance ページに説明文がなく、空状態が中央配置のカードで表示される。
2. Artifacts で item を数件開いた後、Home に直近アクセスが新しい順で並び、
   クリック1回で該当 item が開く。
3. item 右クリック → Open in New Window で別ウィンドウ(web: 新タブ/ウィンドウ、
   desktop: 新規アプリウィンドウ)に該当ページが表示される。
4. agent が `workbench.local.artifact.open` を呼ぶと、既定ブラウザで該当ページが開く。
   origin外URLは構築不可能である。
