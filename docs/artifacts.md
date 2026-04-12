# Artifacts — 設計・実装ドキュメント

Artifacts ページ (`ArtifactsPage.tsx`) の主要機能・実装方針をまとめます。

---

## ファイル構成

```
ui/src/artifacts/
├── components/
│   ├── ArtifactsIcons.tsx      ← SVG アイコン群
│   ├── DirectoryBrowser.tsx    ← ツリービュー
│   ├── PdfViewer.tsx           ← PDF プレビュー（拡大・コメント統合）
│   ├── PdfViewer.css           ← PdfViewer 専用スタイル
│   └── PdfPageComments.tsx     ← ページ別コメント（localStorage）
├── hooks/
│   └── useArtifactsMarkdownEditor.ts  ← Markdown エディタ操作
├── types.ts                    ← ドラフト・ツリー・コンテキストメニュー型
└── utils/
    ├── editorTransforms.ts     ← bold / strike / list-level 変換
    ├── file.ts                 ← isPdf / isImage / formatSize
    ├── notionMarkdown.ts       ← Notion ブロック ↔ Markdown 変換
    ├── path.ts                 ← パス操作ユーティリティ
    └── tree.ts                 ← ツリー構築・走査
```

---

## PDF ビューアー

### 概要

`PdfViewer.tsx` が PDF プレビューの責務を担います。  
`ArtifactsPage.tsx` は `pdfBlobUrl`・`pdfExpanded` を管理し、`PdfViewer` に props として渡します。

```
ArtifactsPage
  └── PdfViewer
        ├── ツールバー（ラベル + 拡大/縮小ボタン）
        ├── <iframe>（blob URL）
        └── PdfPageComments
```

### 拡大表示

Markdown エディターの `editor-expanded` と同じ仕組み。

| 操作 | 動作 |
|---|---|
| ツールバーの展開ボタン | `pdfExpanded` トグル |
| `Ctrl+Shift+↑` | PDF 拡大（PDF ビューアー表示中のみ） |
| `Ctrl+Shift+↓` | PDF 縮小（PDF ビューアー表示中のみ） |

**実装ポイント:**
- `shortcutStateRef.current.pdfViewerVisible` が `true` のときのみショートカットが有効。
- `draft.kind === "file" && isPdf(draft)` の場合に `true`。
- 拡大時は `va-form-grid.pdf-expanded` クラスが付与され、CSS でオーバーレイ表示。
- 別 Artifact へ切り替えると `pdfExpanded` は自動リセット。

### ページ別コメント

`PdfPageComments.tsx` がコメントを管理します。

**ストレージ:** `localStorage`（サーバー API 不要）  
**キー:** `workbench_pdf_comments_<artifactId>`  
**データ形式:**
```json
{
  "1": [{ "id": "...", "text": "...", "createdAt": "ISO8601" }],
  "3": [...]
}
```

**機能:**
- ページ番号入力でコメントを切り替え。
- コメントがあるページを pill（小ボタン）で一覧表示 → クリックでジャンプ。
- コメント追加：`Ctrl+Enter` または「Add」ボタン。
- コメント編集：`✎` ボタン → インライン編集 → `Ctrl+Enter` or 「Save」。
- コメント削除：`✕` ボタン。

---

## キーボードショートカット（フロントエンド内）

> グローバルショートカット（OS レベル）は `docs/native/shortcuts.md` を参照。

| ショートカット | 条件 | 動作 |
|---|---|---|
| `Ctrl+N` | 常時 | 新しいノートを作成 |
| `Ctrl+S` | 保存可能なとき | 保存 |
| `Ctrl+Shift+V` | Markdown エディター表示中 | Edit / Live プレビュー切替 |
| `Ctrl+Shift+↑` | Markdown エディター表示中 | エディター拡大 |
| `Ctrl+Shift+↓` | Markdown エディター表示中 | エディター縮小 |
| `Ctrl+Shift+↑` | PDF ビューアー表示中 | PDF 拡大 |
| `Ctrl+Shift+↓` | PDF ビューアー表示中 | PDF 縮小 |
| `Alt+←` / マウスボタン3 | 常時 | Artifact 履歴を戻る |
| `Alt+→` / マウスボタン4 | 常時 | Artifact 履歴を進む |

**実装:** `ArtifactsPage.tsx` の `useEffect` 内で `window.addEventListener("keydown", ...)` によりハンドル。  
`shortcutStateRef` を介して最新の状態を参照（`useEffect` 依存配列を空にするため）。

---

## Markdown エディター拡大

`editor-expanded` クラスで `va-form-grid` を絶対配置オーバーレイにし、コンテンツセクションを `flex: 1` で引き伸ばします。  
PDF 拡大（`pdf-expanded`）も同じパターンで実装されています。
