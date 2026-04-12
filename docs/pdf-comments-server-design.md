# PDF ページコメント — サーバー移行設計

## 現状

- **保存先**: `localStorage` のみ
- **キー**: `workbench_pdf_comments_<artifactId>`
- **データ形式**: `Record<pageNumber, PdfComment[]>`（ページ番号文字列 → コメント配列）
- **問題点**: 端末をまたいで共有できない。ブラウザデータ削除で消える。

---

## 目標アーキテクチャ

```
フロントエンド
  ├── 即時表示: localStorage キャッシュから読む
  ├── バックグラウンド同期: サーバーから取得 → キャッシュ更新
  └── 書き込み: 楽観的更新（localStorage先行） → サーバーへ非同期送信
         └── 失敗時: pending キューに積んで次回リトライ

サーバー (artifacts service)
  └── PostgreSQL: artifact_page_comments テーブル
```

---

## 1. サーバー側設計

### 1-1. DB スキーマ

```sql
CREATE TABLE artifact_page_comments (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL,           -- artifact_items.id への参照
  owner_username TEXT NOT NULL,          -- 作成者（service_accounts.username_snapshot）
  page          INTEGER NOT NULL CHECK (page >= 1),
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ             -- ソフトデリート（同期のため）
);

CREATE INDEX idx_apc_artifact_updated
  ON artifact_page_comments(artifact_id, updated_at DESC);

-- 論理削除を含まない通常参照用
CREATE INDEX idx_apc_artifact_active
  ON artifact_page_comments(artifact_id, page)
  WHERE deleted_at IS NULL;
```

**ソフトデリートを採用する理由**: クライアントが `lastSyncedAt` 以降の差分だけ取得する差分同期に対応するため。物理削除だと「何が消えたか」を伝えられない。

### 1-2. API エンドポイント

すべて `requireUserAuth` ミドルウェアで保護。パスは既存の artifacts API に合わせる。

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/artifacts/items/:id/comments` | コメント一覧取得（差分同期対応） |
| `POST` | `/api/artifacts/items/:id/comments` | コメント作成 |
| `PATCH` | `/api/artifacts/items/:id/comments/:commentId` | コメント編集 |
| `DELETE` | `/api/artifacts/items/:id/comments/:commentId` | コメント削除（ソフトデリート） |
| `POST` | `/api/artifacts/items/:id/comments/batch` | バッチ書き込み（初回マイグレーション・pending フラッシュ用） |

#### GET クエリパラメータ

```
?since=<ISO8601>   省略時: 全件返す（初回ロード）
                   指定時: updated_at > since の差分だけ返す（差分同期）
                   deleted_at != null のものも差分に含める（削除通知）
```

#### レスポンス型

```typescript
// GET /comments レスポンス
interface CommentListResponse {
  comments: ServerComment[];
  fetchedAt: string;  // サーバー時刻 ISO8601 — 次回の since に使う
}

interface ServerComment {
  id: string;
  artifactId: string;
  page: number;
  text: string;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;  // null = 存在, non-null = 削除済み
}
```

#### POST / PATCH リクエスト型

```typescript
// POST body
interface CreateCommentBody {
  id: string;    // クライアント生成 UUID — 楽観的更新と突き合わせるため
  page: number;
  text: string;
}

// PATCH body
interface UpdateCommentBody {
  text: string;
}
```

**クライアント生成 ID を受け入れる理由**: 楽観的更新でローカル state が先に ID を持つため、サーバーが別 ID を返すと突き合わせが難しくなる。冪等性も確保しやすい。

---

## 2. フロントエンド同期設計

### 2-1. localStorage の役割変更

| キー | 役割 | 変更 |
|---|---|---|
| `workbench_pdf_comments_<id>` | **サーバーキャッシュ**（CommentStore 形式を維持） | 継続 |
| `workbench_pdf_comments_sync_<id>` | 最終同期時刻 `{ lastSyncedAt: ISO8601 }` | **新規** |
| `workbench_pdf_comments_pending_<id>` | 未送信操作キュー `PendingOp[]` | **新規** |

### 2-2. PendingOp 型

```typescript
type PendingOpKind = "create" | "update" | "delete";

interface PendingOp {
  kind: PendingOpKind;
  commentId: string;
  page?: number;      // create のみ
  text?: string;      // create / update のみ
  enqueuedAt: string; // ISO8601
}
```

### 2-3. 読み込みフロー（アーティファクトを開いたとき）

```
1. localStorage キャッシュを読み → 即時表示（0ms）

2. GET /comments?since=<lastSyncedAt> をバックグラウンド実行
   ├── 成功:
   │     a. レスポンスを既存キャッシュにマージ（後述）
   │     b. lastSyncedAt を fetchedAt で更新
   │     c. UI を再レンダリング
   │     d. pending キューをフラッシュ（後述）
   └── 失敗（オフライン等）:
         キャッシュのまま継続。次回オープン時にリトライ。
```

#### マージ戦略（サーバー優先、last-write-wins）

```typescript
function mergeServerComments(
  cache: CommentStore,
  serverComments: ServerComment[]
): CommentStore {
  const next = structuredClone(cache);

  for (const sc of serverComments) {
    const pageKey = String(sc.page);
    if (!next[pageKey]) next[pageKey] = [];

    if (sc.deletedAt) {
      // 削除: キャッシュから除去
      next[pageKey] = next[pageKey].filter((c) => c.id !== sc.id);
    } else {
      // 追加 / 更新: id で突き合わせて upsert
      const idx = next[pageKey].findIndex((c) => c.id === sc.id);
      const comment = { id: sc.id, text: sc.text, createdAt: sc.createdAt };
      if (idx >= 0) next[pageKey][idx] = comment;
      else next[pageKey].push(comment);
    }

    if (next[pageKey].length === 0) delete next[pageKey];
  }

  return next;
}
```

### 2-4. 書き込みフロー（追加 / 編集 / 削除）

```
1. ローカル state & キャッシュを即時更新（楽観的更新）

2. pending キューに PendingOp を追加

3. サーバーへリクエスト送信
   ├── 成功: pending キューから該当 op を削除
   └── 失敗:
         pending キューに残す（次回フラッシュでリトライ）
         ※ UI はロールバックしない（楽観的更新を維持）
         ※ 重大な競合は将来的に「!」バッジで通知する余地を残す
```

### 2-5. pending キューのフラッシュ

サーバーへの接続が確認できたタイミング（主に GET 成功後）に実行する。

```
POST /comments/batch リクエスト
  body: { ops: PendingOp[] }

成功 → pending キューをクリア
失敗 → 残したままにして次回リトライ
```

バッチエンドポイントは冪等に実装する（同じ commentId の create を2回受けても1回にする）。

---

## 3. 初回マイグレーション

既存の localStorage データをサーバーに移行する一回限りの処理。

```
条件: GET /comments が空配列を返す && localStorage にコメントが存在する

処理:
  1. localStorage の全コメントを PendingOp(create) に変換
  2. POST /comments/batch で一括送信
  3. 成功後: lastSyncedAt を設定、pending キューをクリア
  4. 失敗: pending キューに残してリトライ（次回オープン時）
```

マイグレーション済みフラグは `lastSyncedAt` が存在することで判断できるため、専用フラグは不要。

---

## 4. 競合ポリシー（将来検討）

| シナリオ | 現設計の扱い | 将来の改善余地 |
|---|---|---|
| 同一コメントをA端末とB端末が同時編集 | サーバーの updatedAt が新しい方が残る（last-write-wins） | 編集中バッジ、OT/CRDT |
| オフライン中の削除とオフライン中の編集が競合 | サーバーのソフトデリートが優先（マージ時に削除） | 競合通知 UI |
| pending が大量に溜まった場合 | batch で一括送信 | キュー上限・古い op の破棄 |

---

## 5. 実装ステップ（順序）

```
Phase 1: サーバー
  1. db.ts: artifact_page_comments テーブルの DDL を ensureArtifactsSchema に追加
  2. artifactCommentsStore.ts: CRUD 関数を新規作成
  3. httpServer.ts: 4エンドポイント + batch を追加

Phase 2: フロントエンド API
  4. api.ts: commentsApi オブジェクトを追加
     - list(artifactId, since?)
     - create(artifactId, op)
     - update(artifactId, commentId, text)
     - remove(artifactId, commentId)
     - batch(artifactId, ops)

Phase 3: フロントエンド同期フック
  5. usePdfComments.ts: 同期ロジックを hooks として切り出す
     - state: store, pendingOps, syncStatus
     - effects: バックグラウンド fetch、pending フラッシュ
     - actions: addComment, editComment, deleteComment

Phase 4: UI 切り替え
  6. PdfPageComments.tsx: localStorage 直アクセスを廃止、usePdfComments を使用
  7. 初回マイグレーション処理を usePdfComments 内に実装

Phase 5: クリーンアップ
  8. docs 更新
  9. 旧 localStorage ヘルパー（loadStore / persistStore）削除
```

---

## 6. 変更ファイルサマリー

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `services/artifacts/src/db.ts` | 変更 | `artifact_page_comments` DDL 追加 |
| `services/artifacts/src/artifactCommentsStore.ts` | 新規 | CRUD + batch ロジック |
| `services/artifacts/src/types.ts` | 変更 | `ArtifactPageComment` 型追加 |
| `services/artifacts/src/httpServer.ts` | 変更 | コメント系エンドポイント追加 |
| `ui/src/lib/api.ts` | 変更 | `commentsApi` 追加 |
| `ui/src/artifacts/hooks/usePdfComments.ts` | 新規 | 同期フック |
| `ui/src/artifacts/components/PdfPageComments.tsx` | 変更 | フック使用に切り替え |
