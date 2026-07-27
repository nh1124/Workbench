# Workbench 整理整頓 / リファクタリング計画（2026-07-25）

調査担当: Claude（最終レビュー責任）／二次レビュー: Codex（read-only, gpt-5 high）
対象コミット: `8ae1585` 時点の HEAD

---

## 0. 結論サマリ

**ファイル配置の「散乱」は想定よりずっと軽微**。作業ツリーは調査開始時点でクリーン、未追跡ファイルゼロ、`.gitignore` は dist / .env / target を正しく網羅、TODO/FIXME 負債は実質ゼロ。片付けるべきは**数個のゴミディレクトリと命名の紛らわしさ**だけで、半日で終わる。

**本当の問題はコード側の肥大と重複**。とくに以下 2 ファイルが構造的な負債の中心:

| ファイル | 行数 | 中身 |
|---|---|---|
| `services/sync-daemon/src/index.ts` | 8,073 | 設定・同期・オフライン CRUD・手書き HTTP ルータが 1 ファイル |
| `services/workbench-core/src/httpServer.ts` | 7,293 | OAuth2 認可サーバ + 217 ルートが 1 ファイル |

この 2 つで全バックエンドソースの **約 27%**。加えて、検証済みのセキュリティ / 正当性の問題が 7 件ある（§3）。

---

## 1. 現状確認

### 1.1 規模

追跡ファイル数: services 329 / ui 167 / infra 41 / docs 40 / native 20 / scripts 10 / .agents 10

| ワークスペース | src 行 | test 行 | test 比 |
|---|---:|---:|---:|
| ui | 34,599 | 4,924 | 14% |
| workbench-core | 23,086 | 7,558 | 33% |
| sync-daemon | 13,354 | 5,725 | 43% |
| tasks | 5,975 | 1,480 | 25% |
| analyser | 4,991 | 2,558 | 51% |
| projects | 4,355 | 885 | 20% |
| artifacts | 3,446 | 114 | 3% |
| images | 2,562 | 0 | **0%** |
| wbs | 2,372 | 111 | 5% |
| native/desktop | 2,241 | 0 | **0%** |
| mindmaps | 1,326 | 0 | **0%** |
| notes | 813 | 72 | 9% |

テストが実質ゼロなのは images / mindmaps / native/desktop、ほぼゼロが artifacts / wbs。

### 1.2 500 行超のファイル

**バックエンド**: sync-daemon/index.ts 8073、core/httpServer.ts 7293、artifacts/artifactItemsStore.ts 1888、core/projectContext.ts 1675、core/internalClients.ts 1661、core/localClientsStore.ts 1474、sync-daemon/manifestStore.ts 1210、core/mcp/registerTasksTools.ts 1027、wbs/store.ts 1021、core/deepResearch/service.ts 998

**UI**: ArtifactsPage.tsx 3451、lib/api.ts 2407、SettingsPage.tsx 2236、AnalyserPage.tsx 1884、tasks/TasksPageContainer.tsx 1683、types/models.ts 1492、MindmapsPage.tsx 1348、WbsPage.tsx 1227、tasks/hooks/useTaskMutations.ts 1211

### 1.3 良好な点（変更不要）

- 作業ツリーがクリーン、未追跡ファイルなし
- `.gitignore` が `dist/` `.env` `src-tauri/target/` `node_modules/` を適切に網羅
- TODO/FIXME/HACK コメントが実質ゼロ（1 件はテストデータ内の文字列）
- サービス境界（1 サービス 1 DB）が実際に守られている
- `infra/env_samples/` に 12 サービス分の `.env.example` が揃っている

### 1.4 整理対象（実害のあるもの）

| # | 対象 | 内容 |
|---|---|---|
| T1 | `.codex/`, `.codex-dev-logs/` | 2026-06-28〜07-02 の Vite 開発ログ。`.err.log` は 0 バイト。完全な残骸 |
| ~~T2~~ | ~~`logs/` (約 1.8 MB)~~ | **取り下げ（2026-07-26）**。`@workbench/logging` が既に 14 日保持＋日次スイープを実装済み（`WORKBENCH_LOG_RETENTION_DAYS`）。現存ファイルは全て保持期間内で、手動削除は不要かつ有害。実際の不足は**環境変数が未文書だったこと**で、README に追記して解決 |
| T3 | `docker-compose.yml`（root）と `infra/docker-compose.yml` | **別物**（前者=DB スタック、後者=Cloudflare tunnel の edge プロファイル）なのに同名。事故のもと |
| ~~T4~~ | ~~`CLAUDE.md` が `.gitignore` に入っている~~ | **取り下げ（2026-07-26）**。本番サーバ情報・一時チャネル URL などの機密が含まれるため、意図的な除外。機密を分離しない限り公開しない方針で正しい |
| T9 | `ui/tsconfig.tsbuildinfo` が追跡されていた | 型チェックのたびに再生成され、無関係なコミットに差分が混入していた。**対応済み** |
| T5 | `docs/imple/` 28 本中 約 20 本が「完了」表記のまま未アーカイブ | 現役の計画書が埋もれる |
| T6 | `insights` 命名の残存 | `.agents/skills/workbench-analyser-cycle/SKILL.md`、`workbench-maintenance/references/tool-contracts.md`、docs 5 本 |
| T7 | `services/logging` | 唯一の素 JS ワークスペース。手書き `index.d.ts` + `build: node --check` |
| T8 | `ui/src` の二重構造 | feature フォルダ（`artifacts/` `tasks/` `projects/`）と フラット `pages/`（19 ページ）が混在。`components/` は 8 個しかない |

---

## 2. 整理整頓案

### Phase 0 — 即実行（低リスク・約 30 分）

1. ✅ **T1**: `.codex/` `.codex-dev-logs/` を削除し、`.gitignore` に追記
2. ~~**T2**~~: 取り下げ（§1.4 参照）。代わりに `WORKBENCH_LOG_RETENTION_DAYS` 等を README に文書化
3. ✅ **T3（縮小）**: `infra/docker-compose.yml` → `infra/docker-compose.edge.yml` のみ改名。
   **root の `docker-compose.yml` は移動しない** —— 当初案は誤りだった。`infra/*.sh` `*.bat` の約 8 本が
   `docker compose up -d`（`-f` なし）で**既定のファイル探索に依存**しており、root から動かすと全て壊れる。
   root は docker の慣習どおりの置き場所でもある。edge 側は `start_tunnel.{sh,bat}` が既に明示パスで
   参照していたので 2 ファイルの修正で済んだ。加えて両ファイル冒頭に用途を書いたコメントを追加し、
   「同名で別物」という本来の混乱要因を直接解消した
4. ~~**T4**~~: 取り下げ。`CLAUDE.md` の除外は意図通り（§1.4 参照）。将来的に共有したくなった場合のみ、機密部分を `.env` 相当へ分離してから検討する

### Phase 1 — ドキュメント整理（約 1 時間）

5. ✅ **T5**: `docs/imple/archive/` へ 11 本を移動し、`docs/imple/README.md` に現役一覧を作成。
   **当初の 13 本候補のうち 3 本は未完了だったため現役に残した** —— キーワード数だけで判断せず
   1 本ずつ進捗ボードを読んだ結果、以下が未完了だと判明した（README にも再掲）:
   - `lbs-full-integration-plan` W7: **本番 LBS 移行が未実施**（ユーザー確認必須）
   - `workbench-mcp-feedback-fixes-plan` FB2-R: 本番反映（push）と再受入が残
   - `workbench-maintenance-loop-plan` P3-8: live 環境での forward-test が残
   さらに `wbs-implementation-progress-plan` は一度 archive したが `[in-progress]` を確認して差し戻した。
   archive によって壊れた相互参照 8 箇所も修正済み。
6. ✅ **T6（縮小）**: 一括置換は**しない**のが正解だった。`.agents/skills/` の `insights` 参照は
   「legacy な `insights.*` ツールは存在しないので fall back するな」という**意図的な記述**であり、
   `infra/scripts/migrate-insights-to-analyser.mjs` も名称として正しい。analyser 系 doc の言及も移行の
   歴史説明。実際に紛らわしかったのは `logging-foundation-plan.md` の 2 箇所だけで、完了済み計画の
   記録を書き換えるのは履歴の改竄になるため「insights（現 analyser）」と注記する形に留めた

### Phase 2 — 構造の統一（要判断）

7. **T7**: `services/logging` を TypeScript 化して他サービスと揃える。ただし現状 53 行で動いており実害は小さい。**優先度低**
8. **T8**: `ui/src` を feature-first に寄せる。`pages/XxxPage.tsx` が 1000 行超のものは `ui/src/<feature>/` へ移し、`pages/` は薄いルート定義だけにする。`artifacts/` `tasks/` `projects/` が既にその形なので、**先例に合わせるだけ**。§4 のリファクタと同時に行うのが効率的

---

## 3. コードレビュー結果

Codex の指摘を受けたうえで、**掲載するものはすべて自分で該当コードを読んで裏取り済み**。裏取りできなかった指摘は落とした。

### P0 — セキュリティ

**S1. sync-daemon のループバック API 認証が既定で無効**
`services/sync-daemon/src/index.ts:6647`

```ts
export function requestHasValidLoopbackToken(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;   // ← トークン未設定なら全リクエストを通す
```

`apiToken` は `WORKBENCH_DAEMON_API_TOKEN` / `WORKBENCH_LOCAL_DAEMON_TOKEN` からのみ読まれ、既定値なし（`index.ts:246`）。ドキュメントでも「optional loopback token」「enables token enforcement」と**任意扱い**（`docs/imple/workbench-local-client-sync-daemon-plan.md:495,528`）。

無防備になる範囲は広い。`/api/artifacts/upload`、`/api/artifacts/notes`、`/api/sync/rescan`、`/api/tasks`、`/api/projects`、`/api/notes` など **24 ルート**で、ローカルファイルシステムへの書き込みとオフライン変更が含まれる。

**範囲の正確な切り分け**: CORS の Origin 許可リスト（`isLoopbackOriginAllowed`）が既にあり、リモート Origin は拒否される。よって**悪意あるウェブサイトからの経路は概ね塞がっている**。残る実際の脅威は **Origin ヘッダを持たないローカルプロセス**（`isLoopbackOriginAllowed(undefined) === true`）で、悪意ある npm postinstall などが該当する。

→ **対応済み（2026-07-26）**: 既定を「トークン必須」に反転。未設定時は起動時に生成して `.workbench/daemon-token`（mode 0600）へ永続化し、パスをログ出力。`WORKBENCH_DAEMON_ALLOW_ANONYMOUS=true` で従来動作に戻せる。UI 側の受け口（`ui/src/config/services.ts:215`、`ui/src/lib/api.ts:373`）は既に実装済みだった。

**S2. ブラウザ実行時にリフレッシュトークンが localStorage**
`ui/src/lib/api.ts:301-317`。Tauri ネイティブでは OS のセキュアストレージを使う分岐があり、**ブラウザ経路のみ**の問題。XSS 一発でセッション全体が奪われる。

→ **方針決定（2026-07-26）: httpOnly cookie 化で対応。** ただし他の R0 項目（数行〜十数行）と違い、これは Core のトークン発行・CORS の credentials 設定・UI のトランスポート・Tauri 経路の維持にまたがる**独立した設計作業**。R0 には含めず、**R0.5 として別枠**で扱う（§4 参照）。

### P1 — 正当性

**S3. `ArtifactsPage.loadTree` に競合状態** — `ui/src/pages/ArtifactsPage.tsx:479-506`
`AbortController` も世代カウンタもなく、`setItems(visibleItems)` を無条件に呼ぶ。プロジェクトフィルタを素早く切り替えると、遅い A の応答が後着で B の表示を上書きする。`finally` の `setIsLoading(false)` も B の読込中に発火する。

**S4. HTTP と MCP でスキーマが既に乖離** — `httpServer.ts:1003-1025` vs `mcp/registerImageTools.ts:13-46`
画像生成スキーマが二重定義され、HTTP 側にある `sourceArtifactItemIds` が MCP 側に**ない**。同様の二重定義は mindmaps（`httpServer.ts:1036-1067` / `registerMindmapTools.ts:125-166`）、wbs、deepResearch にもある。tasks / projects は生ボディを転送するので該当しない。乖離は今後も静かに増える。

**S5. タスク添付の変更が Core 由来ヘッダを付けていない** — `internalClients.ts:1090-1114`
`uploadAttachment` / `replaceAttachment` は `fetch` に `Authorization` しか渡さず、他の経路が使う `buildServiceHeaders`（`internalClients.ts:79`）を通らない。`WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN=true` にすると `services/tasks/src/httpServer.ts:97-113` の判定で **403** になる。既定は `false`（env_samples 全て false）なので**今は顕在化しないが、ハードニング時に確実に踏む**潜在バグ。

**S6. `internalClients` の fetch にタイムアウトがない** — `internalClients.ts:93-123`
下位サービスがハングすると Core のリクエストが無限に滞留する。`AbortSignal.timeout()` を共通ヘルパに 1 箇所入れるだけで済む。なお OAuth のクライアントメタデータ取得（`httpServer.ts:569-575`）には正しく 5 秒タイムアウトが入っており、対比として不自然。

**S7. `clientMetadataCache` が無制限に増える** — `httpServer.ts:217`
削除は「同じ clientId が再度要求されたとき」だけ（`httpServer.ts:562-564`）。定期スイープなし。異なる clientId が来続ければ単調増加する。影響はメモリのみで低〜中。

### P2 — 重複

- **`services/*/src/auth.ts`（9 本）**: artifacts / notes / projects はバイト単位で同一、images / mindmaps も同一、wbs は環境変数名 1 つ違い。**9 本中 6 本が実質同一の 106〜109 行**。tasks（サービスアカウント発行なし）と core（トークン発行側）は正当に異なる。→ 共通パッケージ化の価値あり
- **`services/*/src/db.ts`（9 本）**: バイト同一はないが、プール設定と起動リトライの 50〜65 行が 9 本すべてで意味的に重複（`notes/db.ts:11-71`, `projects/db.ts:11-71`）。ドメインスキーマは正当に異なる。→ **接続プール／リトライ／サービスアカウント DDL だけ**を共通化。スキーマは共通化しない
- **`ArtifactsPage.tsx`**: メニュー位置計算が 4 箇所（`318-368`）、ドロップ画像とペースト画像の投入処理が別実装（`1780-1815` / `1817-1886`）
- **`internalClients.ts`**: multipart 組み立てが 4 箇所（artifacts の upload/replace `361-401`/`402-440`、tasks の同 `1090-1114`/`1115-1146`）

---

## 4. リファクタリング案

原則: **動作を変えない機械的分割から始め、テストの薄い領域は分割前にテストを足す**。

### R0 — 先に手当て → **完了（2026-07-26, commit `8a4245f`）**

- ✅ S1: 既定でトークン必須化 + 初回起動時に `.workbench/daemon-token` へ自動生成・永続化。`WORKBENCH_DAEMON_ALLOW_ANONYMOUS` で opt-out
- ✅ S5: tasks の添付 upload/replace を `buildServiceHeaders` 経由に（artifacts 側は元から正しかった）
- ✅ S6: 全 internal fetch に `INTERNAL_SERVICE_TIMEOUT_MS`（既定 30s）を適用、タイムアウトは 504 に変換
- ✅ S7: `clientMetadataCache` に期限スイープ + 上限 500 件
- ✅ S3: `loadTree` に単調増加シーケンスガード
- ✅ 回帰テスト 2 本追加（添付の mutation ヘッダ / タイムアウトの 504 変換）、`loopbackAuth.test.ts` の契約を fail-closed に更新

検証: sync-daemon 133 tests pass / workbench-core 140 pass・18 skip / ui 236 pass、全ワークスペース `tsc --noEmit` クリーン。

### R0.5 — S2: セッションを httpOnly cookie へ → **完了（2026-07-26, commit `7fe2d5c`）**

採用した設計（同一オリジン前提 / access token はメモリのみ）:
- Core が refresh token を `HttpOnly; SameSite=Lax; Path=/auth` cookie で発行。`Secure` は HTTPS 到達時（`x-forwarded-proto` 経由含む）に自動付与
- `POST /auth/refresh` は cookie / body の両方を受け付け、**cookie を優先**。拒否した cookie は削除して再送ループを断つ
- `POST /auth/logout` を追加
- ブラウザは**トークンを一切永続化しない**。access token はメモリのみ、リロード時は cookie を 1 回使ってセッション復元。旧ビルドが localStorage に残したセッションは次回保存時に破棄
- **ネイティブ（Tauri）は意図的に変更なし**。OS セキュアストレージは元々ページから読めず再起動も跨げるため、body 送信のまま
- CORS は**変更不要**だった。同一オリジン前提のため `credentials: true` もオリジン許可リストも導入せずに済み、攻撃面を増やさずに完了
- dev 用に Vite proxy を追加（`VITE_WORKBENCH_CORE_PROXY_TARGET`）。`VITE_WORKBENCH_CORE_URL` を Core 直指しのままにしても動作するが、その場合のみリロードでセッションが切れる
- cookie 処理は 7,000 行の httpServer に足さず `refreshCookie.ts` に切り出した（R1 の前倒し。DB なしでテスト可能になる副次効果あり）

検証: core 221 tests（203 pass / 18 skip・DB 依存）、ui 242 tests all pass、両者 `tsc --noEmit` クリーン。cookie 8 件・セッション 6 件の新規テストを追加。

### R1 — `workbench-core/httpServer.ts` の解体 → **✅ 完了（2026-07-26）**

**7,209 → 192 行（-97%）**。httpServer.ts に残るのは app 構築・middleware・`/health`・UI 配信・起動のみ。

| wave | commit | 内容 | 行数 |
|---|---|---|---|
| pre | `7af4b11` `a09bf22` | OAuth フローテスト 21 件 | — |
| 1 | `14bb1c9` | `oauth/{config,clients,tokens,authorizeRequest}.ts` | -750 |
| 2 | `55d8cfa` | `schemas/requests.ts` + `middleware/auth.ts` | -223 |
| 3 | `68d9118` | `routes/{deep-research,mindmaps,analyser,wbs,images,notes}.ts` + `routes/shared.ts` | -1,655 |
| 4 | `a846c48` | `routes/{local-clients,local-jobs}.ts` | -419 |
| 5 | `eed5f62` | `routes/{artifacts,projects}.ts` | -946 |
| 6 | `0d3124c` | `routes/tasks.ts` | -674 |
| 7 | `3913343` | `routes/sync.ts` | -1,468 |
| 8 | `b9c69b2` | `routes/{oauth,accounts,mcp}.ts` | -882 |

**既知の見た目の負債**: `routes/*.ts` の各 `register*Routes()` の中身はトップレベル相当の
インデントのまま（移動元の字下げを保っている）。これは**意図的**で、本文をバイト一致に保つことが
検証手段そのものだったため。整形したい場合は R1 完了後の独立した formatter パスで行うこと。

**検証方法**（機械的移動であることの証明）。テストが緑なだけでは不十分なので、以下を毎 wave 実施:
1. **ランタイムのルート登録順**を `app._router.stack` から dump し、直前コミットの worktree で取った
   同じ dump と**位置まで含めて完全一致**することを確認（Express はルート順が意味を持つため、
   集合一致では不十分）。差分は `ui/dist` 有無で条件登録される静的配信 2 層のみ
2. 移動した関数が、空白と `export` 修飾子の正規化後に**バイト一致**すること
3. httpServer.ts から消えた行がすべて移動先か残存部に存在すること（取りこぼしゼロ）
4. `routes/*` `oauth/*` が httpServer.ts を import していないこと（循環なし）
5. 全 242 テスト・skip ゼロ、`tsc --noEmit` クリーン

**この過程で検出・修正した実バグ 2 件**:
- `oauth/config.ts` が module load 時に env を読むが、ESM は import 先を importer 本体より先に評価する。
  `auth.js` がたまたま先に dotenv を呼ぶことに依存しており、**import 順の並べ替えで起動不能**になる
  状態だった → config.ts 自身が dotenv を読むよう修正
- `syncEventBroadcaster` が `export { } from` で**再エクスポートのみ**され、ローカル束縛が無いため
  httpServer.ts がコンパイル不能だった（再エクスポートはローカル変数を作らない）

**残り**（次セッション）:
- `routes/sync.ts`（同期の検証・衝突・push 適用, 約 1,200 行）—— push ヘルパ群が大きく、wave 4 では
  時間切れのため**あえて手を付けず**コンパイル可能な状態で停止した
- `routes/{tasks,projects,artifacts}.ts`（約 1,900 行）
- `server.ts`（MCP トランスポート・UI 配信・起動）
- 余力があれば、ファサードの `authenticate → try → client 呼び出し → catch` 同型反復を
  `analyserFacadeRoute` と同じ要領で畳む（**これは機械的移動ではないので別 wave にすること**）

**得られた知見**: `refreshCookie.ts` / `oauth/config.ts` の切り出しで判明したとおり、httpServer.ts を
import すると DB 接続が要る。切り出した単位は DB なしでテストでき、実際 cookie 8 件・schema parity 5 件が
DB 非依存で回るようになった。**分割はテスト可能性を直接改善する**。

#### 当初計画（参考）

現状の責務境界は実は明瞭なので、分割は素直に効く:

| 切り出し先 | 現行の行範囲 | 内容 |
|---|---|---|
| `oauth/` (4〜5 ファイル) | 162-942 | 発行者設定 / クライアント解決・DCR / 認可コード・リフレッシュ / ログイン画面 HTML |
| `schemas/` | 953-1200 | zod スキーマ群（→ R3 で MCP と共有） |
| `middleware/auth.ts` | 1202-1380 | 認証・ローカルクライアント認可・エラー変換 |
| `routes/sync.ts` | 1382-2627 | 同期の検証・衝突・push 適用 |
| `routes/<domain>.ts` | 3535-7088 | ドメインごとのファサード（notes/artifacts/tasks/projects/mindmaps/wbs/images/analyser） |
| `server.ts` | 7089-7293 | MCP トランスポート・UI 配信・起動 |

**前提**: OAuth の HTTP テストは現状メタデータのみ（`oauthMetadataHttp.test.ts`）で、認可コード〜トークン〜リフレッシュの実フローが未カバー。**分割前にこのフローのテストを書く**こと。ここが今回のリファクタで唯一の実リスク。

ファサードは `authenticate → try → client 呼び出し → catch` の同型が延々続く（例: `5874-5887`, `5889-5899`）ので、`makeFacadeRoute()` 1 つで大半が畳める。

### R2 — `sync-daemon/index.ts` の解体 → **着手済み・継続中（2026-07-26）**

**8,122 → 2,128 行（-74%）**。機械的移動で可能な範囲は概ね完了。

| commit | 内容 | 行数 |
|---|---|---|
| `8a6b454` | `config.ts` + `paths.ts`（設定・パス安全性） | -342 |
| `3ceb6ba` | `localProjects.ts` `localNotes.ts`（純粋ヘルパのみ） | -52 |
| `c06df5d` | **`types.ts`（`DaemonState` ほか）← 障壁 1 の除去** | -56 |
| `34a1222` | 既定プロジェクトのキャッシュ系 | -36 |
| `ea2e36f` | **`localStore.ts`（ローカル書き込み基盤）← 障壁 2 の除去** | -70 |
| `9427b99` | `localNotes.ts`（Notes ドメイン全体） | -207 |
| `5a37d77` | `localProjects.ts`（Projects ドメイン全体） | -476 |
| `b522b55` | `localTasks.ts`（Tasks ドメイン 94 関数） | -1,785 |
| `4f1a515` | `localArtifacts.ts`（ローカル投影・`scanSyncFolder`） | -507 |
| `2741ea3` | `remoteSync.ts`（同期エラー分類） | -97 |
| `8a6d62b` | `httpApi.ts`（ループバック HTTP 層） | -212 |

**障壁を先に外すのが鍵だった**。`types.ts` と `localStore.ts` を作るまで 2 wave 空振りしたが、
外した直後から Notes → Projects → Tasks → Artifacts と一気に進んだ。

| `fa2180a` | `localArtifacts.ts`（Artifact CRUD）+ wildcard 再エクスポート除去 | -522 |
| `2733f6f` | `remoteSync.ts`（リモートペイロード解析） | -215 |
| `da0e8d3` | `coreClient.ts`（Core HTTP クライアント） | -200 |
| `8e0601b` | `remoteSync.ts`（リモート照合・apply 群 24 関数） | -646 |
| `b8731a3` | `jobs.ts`（ローカルジョブ処理） | -165 |
| `a19cabd` | `remoteSync.ts`（pull/snapshot/push オーケストレーション） | -430 |

**index.ts に残る 15 関数（2,128 行）** —— デーモンループ（`tick` / `scheduleTick` / `performTick`）、
ウォッチャ、HTTP ルータ（`startStatusServer`）、`main()`、および下記の循環に絡む 6 関数。

**ここから先は機械的移動では進まない**。`scheduleTick → tick → pushOutbox / pullRemoteArtifactSyncState`
と、`markProjectContextRescanRequired → scheduleTick` が**真の相互依存**を作っている。
解くには依存性注入（`scheduleTick` をパラメータで渡す等）が必要で、これは**関数シグネチャの変更＝設計変更**。
バイト一致検証が使えなくなるため、独立した設計判断として別途行うこと。

**wildcard 再エクスポートの注意**: 委譲すると `export * from "./x.js"` を書かれることがある。これは
分割前に private だったヘルパを公開 API に昇格させてしまうため、**必ず明示リストに直す**
（本作業では 3 箇所を差し戻した）。

**なぜ R1 ほど進まないか**: Core のルートハンドラは互いに独立していたが、daemon は
`DaemonState` を全域で引き回す設計で、関数が相互に依存している。1 つ動かすには依存の連鎖を
先に動かす必要がある。実際 2 回、依存の壁で wave が空振りした。

**除去済みの障壁**（これが R2 の実質的な成果）:
1. `types.ts` — `DaemonState` が index.ts にあったため、参照する全モジュールが循環になっていた
2. `localStore.ts` — `localWriteContext`(AsyncLocalStorage) / `enqueueManifestOutbox` /
   `runWithClientOpId` / `refreshManifestStats` / ID ヘルパ群

**次 wave の具体的な手順**（旧メモ・下記は完了済み）:
1. `localStore.ts` へ次を移す —— note/project CRUD が直接呼んでいる残りの依存:
   `asString`, `asNumber`, `localRemoteDomainItem`, `listLocalRemoteDomainItems`,
   `supersedeOpenOutboxForPath`
2. そのうえで `localNotes.ts` へ `normalizeLocalNotePayload` / `localNoteProjectSummaries` /
   `createLocalNote` / `updateLocalNote` / `deleteLocalNote`（index.ts 1073-1235 付近）
3. 同様に `localProjects.ts` へ project CRUD 群
4. 続いて remote pull/push（約 1,700 行）、手書き HTTP ルータ（約 1,500 行）、`main()`

**Codex 委譲時の必須注意**: reasoning effort を下げると**移動時に整形してしまう**（複数行式の 1 行化、
`if (x) { return y; }` → `if (x) return y;`）。意味は同じでもバイト一致検証が効かなくなり、
パストラバーサル判定から波括弧が消えるなど品質面でも劣化する。プロンプトに
「**NO REFORMATTING / byte for byte**」を最上部で明示し、移動後は必ずバイト一致を検証すること。

#### 当初計画（参考）

| 切り出し先 | 現行の行範囲 |
|---|---|
| `config.ts` / `registration.ts` | 100-445 |
| `paths.ts`（sanitize・traversal 判定） | 447-610 |
| `localProjection.ts` | 611-930 |
| `offline/{projects,notes,tasks}.ts` | 932-3548 |
| `artifacts/` | 3549-4512 |
| `remote/{pull,push,conflict}.ts` | 4513-6182 |
| `jobs.ts` / `scheduler.ts` | 6183-6468 |
| `httpApi/`（手書きルータ） | 6472-7996 |
| `main.ts` | 7998-8073 |

こちらはテスト資産が厚い（`pathSafety` / `remotePull` / `syncFolderRecovery` で 5,725 行）ので R1 より安全。ただし HTTP ルータ部分はソースレベルの検証（`routeCoverage.test.ts`）止まりで実リクエストのテストがない。

**ついでに直す**: リクエストボディが無制限にバッファされる（`6472-6488`）、ジョブダウンロードが `maxSyncFileBytes` を見ずに全バッファ（`526-548`）、確認待ちマップに TTL がない（`6204-6270`）。

### R3 — スキーマの一元化（1〜2 日）

`schemas/<domain>.ts` を作り、HTTP と `mcp/register*Tools.ts` の両方がそこから import する。S4 の乖離が構造的に起きなくなる。対象は images / mindmaps / wbs / deepResearch の 4 ドメインのみで、範囲は限定的。

### R4 — サービス共通パッケージ → **大幅に縮小（2026-07-26 再評価）**

当初「auth と db を共通パッケージへ」と提案したが、**マイクロサービスとして各サービスを独立保守する**という設計意図を踏まえて再検討した結果、**大部分を取り下げる**。理由:

**共通ライブラリ化は、マイクロサービスが避けようとしている結合をそのまま持ち込む**。
- 共通 `auth` を変更すると 6 サービスの協調再デプロイ・再テストが必要になる。これは分散モノリスの定義そのもの
- 影響範囲も逆に広がる。現状なら `notes/auth.ts` のバグは notes だけを壊すが、共通化すると一度に全滅する
- AI 作業範囲の縮小という意図も実利がある。今は notes の作業でエージェントが読むのは 800 行程度で、wbs を壊しようがない。共通化すると、あらゆる変更が 6 consumer への影響を考える作業になる

**そもそも費用対効果が薄い**。重複しているのは 106 行 × 6 ≒ 640 行で、6 万行規模のコードベースでは誤差。これを消すために 2〜3 日と恒久的な結合を払うのは割に合わない。

**ただし 1 点だけ、重複のコストが非対称になる箇所がある** —— セキュリティプリミティブ。JWT 検証に欠陥（alg 混同、`aud` 未検証、クロックスキュー等）が見つかった場合、6 箇所を漏れなく直す必要があり、「全サービスが修正済み」を 1 ファイル読んで確認できない。しかも**意図しないドリフトが既に発生している**（wbs は環境変数名が 1 つ違い、analyser は同一挙動だがフォーマット違い）。誰も「wbs だけ変えよう」と決めた形跡はない。

→ **推奨（結合を作らずドリフトだけ検出する）**: 共通ライブラリではなく**共通の適合テスト**を置く。各サービスの auth に対し「同じ不正トークン群（期限切れ / 署名不正 / aud 違い / alg=none）を同じように拒否するか」を検証するテストスイートを 1 本用意する。テストの共有は**実行時結合もデプロイ結合も生まない**し、AI の作業範囲も広げない。それでいてドリフトは CI で必ず落ちる。

**`db.ts` は完全に取り下げ**。プール設定と起動リトライの重複は、安定していて滅多に変わらない退屈なコードで、共通化の対価に見合わない。

修正後の見積り: **0.5 日**（適合テスト 1 本）。

### R5 + T8 — UI → **レイアウト整理は完了、内部分解は未着手（2026-07-27）**

**`lib/api.ts` 2,469 → 112 行（-95%）**

| commit | 内容 |
|---|---|
| `99752ef` | `api/transport.ts`（セッション状態・HTTP トランスポート・refresh・自動ルーティング） |
| `a7d18e3` | `api/{notes,artifacts,tasks,projects,analyser,images,mindmaps,wbs,deepResearch,core}.ts` |

`api.ts` は明示的な再エクスポートで**公開面を完全に維持**したので、`lib/api` を import している
約 40 ファイルは無変更。13 個のドメイン API オブジェクトは**空白まで含めて完全一致**を確認済み
（`projectsApi` 219 行、`analyserApi` 168 行）。

**T8: `pages/` 11,382 → 3,832 行**。1,000 行超のページを feature ディレクトリへ移動し、
`pages/` は 1 行の再エクスポートだけにした（App.tsx・ルート定義・既存テストは無変更）。

| ページ | 行 | 移動先 |
|---|---:|---|
| ArtifactsPage | 3,451 | `artifacts/` |
| SettingsPage | 2,236 | `settings/`（新規） |
| AnalyserPage | 1,884 | `analyser/`（新規） |
| MindmapsPage | 1,348 | `mindmaps/`（新規） |
| WbsPage | 1,227 | `wbs/`（新規） |
| ProjectDetailPage | 865 | `projects/` |

`pages/` と feature ディレクトリは同じ深さ（`src/` 直下）なので、`../lib` `../types` などは
そのまま有効。書き換えが要ったのは自分の feature ディレクトリを指す import だけ。

**ページ内部の分解: テスト拡充 → フック抽出に着手（2026-07-27）**

`ArtifactsPage.tsx` は単一コンポーネントに 66 フック・約 2,450 行のロジックが入っており、
**機械的移動ではないためバイト一致検証が使えない**。R1 で OAuth テストを先に書いたのと同様、
テストを先に厚くしてから着手した。

| commit | 内容 |
|---|---|
| `0f21ae6` | 特性化テスト 9 件（save の update/create 分岐・空タイトルガード・保存後の再読込・削除確認とキャンセル・フォルダ作成と空名拒否・エディタが開いた項目に留まること） |
| `07fdc70` | `useArtifactPreview`（PDF/画像 blob・Word プレビューのポーリング。**effect 本文はバイト一致**） |
| `7aa22f8` | `useArtifactContextMenus`（4 メニューのクランプ + Escape/resize/scroll での一括クローズ）+ テスト 2 件 |

`ArtifactsPage.tsx` 3,451 → **3,288 行**。UI テストは 242 → **253 件**。

**全ての新規テストは mutation で有効性を確認済み**（空タイトルガード削除・削除確認バイパス・
クランプ無効化を注入し、対応するテストだけが赤くなることを確認）。

| `0d3bc62` | `utils/notionTableOps.ts`（テーブル操作 4 関数）+ **ユニットテスト 17 件** |

`ArtifactsPage.tsx` 3,451 → **3,108 行**。UI テストは 242 → **270 件**。

**table 操作は「抽出したからテストできた」例**。`notionEditorRef` を閉じ込める代わりに editor を
引数で受け、`applyTableOperation` は setter を呼ばず次の選択を**返す**形にした。これで React の外で
呼べるようになり、jsdom で組んだテーブルに対して直接テストできる。

mutation で**どのアサーションが実際に効いているか**も確認した:
- insert-row の above/below を入れ替える → insert 系 2 件が赤（効いている）
- delete-columns を off-by-one にする → column 系 2 件が赤（効いている）
- **ヘッダ保護の `Math.max(1, ...)` と空行フォールバックを外しても何も赤くならない** ——
  削除は tbody にしか触れず、後段の `ensureNotionTableBlockStructure` が正規化し直すため。
  つまりこの 2 つは冗長。ただし**テストが赤くならないことを理由に消すのは危険**なので現状維持とした。

判明した仕様: テーブルは**本文 1 行以上・2 列以上**を維持する（それ以下に削除すると空の行/列が補充される）。

**まだ抽出していないもの**: editor の contenteditable 操作（マウスドラッグによるセル選択、
`handleNotionEditor*`）。jsdom では Selection API が限定的で、テストの投資が大きい。
`loadTree` も選択・draft・mode と密結合で、抽出すると引数 8 個のフックになり
「移しただけで悪化」になるため見送った。

#### SettingsPage / AnalyserPage（2026-07-27〜28）

| commit | 内容 |
|---|---|
| `50d4cbb` | SettingsPage sync daemon の特性化テスト 7 件 |
| `422f888` | `hooks/useLocalDaemonSettings.ts`（state 12・ハンドラ 20） |
| `d321964` | AnalyserPage をタブ単位のコンポーネントファイルへ分割 |

- **SettingsPage 2,236 → 1,905 行**。最大クラスタ（ローカルデーモン）をフック化。
- **AnalyserPage 1,884 → 56 行**。こちらは**既に 11 個のコンポーネントに分かれていた**ので、
  1 ファイルに同居していたものを `analyser/components/` へ出すだけの純粋な分割。
  移動した 30 コンポーネントはバイト一致（`ActivityTab` 311 行・`RoutinesTab` 305 行は空白まで一致）。

**テスト作成中に発見した UX バグ → 修正済み（`469afd2`）**: `refreshLocalDaemon` の先頭が
`setLocalDaemonMessage("")` のため、確認メッセージを set した直後に refresh を呼ぶ経路では
**メッセージが即座に消えていた**（`showSuccess=false` なので再設定もされない）。
調べると影響は当初気づいた 2 箇所ではなく **5 箇所**で、「Daemon started.」「Daemon stopped.」も
一度も表示されていなかった。`refreshLocalDaemon(showSuccess, { keepMessage })` を追加し、
各呼び出し側が「自分がメッセージの持ち主か」を明示する形にした。初期ロードは従来どおりクリアし、
**失敗時は必ず上書き**（エラーは見えないと困るため）。現状を pin していた 2 テストは反転させ、
修正を戻すと赤くなることを確認済み。

#### MindmapsPage / WbsPage（2026-07-28, `48aeee7`）

どちらも**単一コンポーネント + 前置きの純粋関数群**という構造で、**テストが 1 件も無かった**。
純粋関数を `mindmaps/utils/mindmapTree.ts` / `wbs/utils/wbsTree.ts` へ切り出し（23 関数バイト一致）、
**ユニットテスト 40 件**を追加した。`notionTableOps` と同じ「抽出したからテストできた」パターン。

- MindmapsPage 1,348 → **1,230 行**、WbsPage 1,227 → **1,155 行**
- カバーした範囲: ツリーの find/update/remove/insert、ノード数、ズームのクランプ、キャンバス
  レイアウト（折りたたみ時の子の除外含む）／WBS の行フラット化と並び順、兄弟・子孫判定、
  進捗クランプ、イベントターゲット判定
- 名前から読み取れない仕様を 2 つ明文化: `extensionForFilename` は**先頭のドットと大文字小文字を保持**し
  既定は `.txt`（file-picker の accept 用のため）／`flattenWbsItems` は**親が存在しない item を落とす**
- mutation 検証: `removeNode` の再帰を止める・`isDescendantItem` を 1 段で打ち切る、で各 1 件が赤

UI テストは 278 → **318 件**。

#### 当初計画（参考）

- `ArtifactsPage.tsx` 3451 行 → `ui/src/artifacts/` へ。state 39 個をまず `useReducer` か複数フックに割る。既に `ui/src/artifacts/hooks/` があるのでそこに寄せる
- `lib/api.ts` 2407 行 → `lib/api/<domain>.ts` へ分割。トランスポート（Core / daemon / フォールバック / リフレッシュ）を `lib/api/transport.ts` に集約。リフレッシュ後の失敗が元の 401 を再 throw してセッションを消す挙動（`933-1004`）もここで直す
- `SettingsPage.tsx` 2236 行 → セクションごとのコンポーネントへ

### 優先順位

```
✅ R0 → ✅ R3 → ✅ R4' → ✅ R0.5 → ✅ Phase 0/1 → ✅ R1-pre → ✅ R1（-97%）→ 🔄 R2（-74%）→ 🔄 R5+T8（大部分完了）
  → R2（daemon 8,073 行）→ R5 + T8（UI）
```

**Codex 委譲時の注意（実測）**: R1 wave 3/4 では Codex(MCP) が 30 分の無応答 abort に 2 回かかった。
プロセスは生き残って作業を続けるため、abort 後は (1) ファイルの mtime/md5 が安定するまで待つ、
(2) `tsc` と全テストを自分で流す、(3) commit 前に `git status` を確認、の順で扱うこと。
wave 3 では abort 後にコンパイル不能な状態が残っており、こちらで修正した。
**「1 wave = 20 分以内に終わる分量」に絞り、収まらない場合は縮退してでもコンパイル可能な状態で止める**
よう指示に明記すると、wave 4 のように安全に部分完了できる。

**テスト実行環境の注意**: core の全テストを skip ゼロで回すにはローカル Postgres が必要。
`docker compose up -d workbench-core-db` を先に実行すること。DB なしだと 18 件が skip され、
OAuth フローの検証が丸ごと抜ける。

**セキュリティ系（S1〜S7）・再発防止テスト・掃除は全て完了。** 残るのは大物の分割のみ。

R1 の前提条件は変わらず「OAuth の認可コード〜トークン〜リフレッシュの実フローのテストを先に書く」。
なお R0.5 で `refreshCookie.ts` を切り出した際、httpServer を import すると DB が必要になる（既存 18
テストが skip される理由）ことが分かった。**R1 の分割は、副次的にテスト可能性を大きく改善する**。

---

## 5. 進捗ボード

| ID | 項目 | 状態 | 備考 |
|---|---|---|---|
| Phase0-T1 | `.codex*` 削除 | **完了** | `.gitignore` 追記済み |
| ~~Phase0-T2~~ | ~~`logs/` 整理~~ | **取り下げ** | 保持機構は実装済み。README に文書化して代替 |
| Phase0-T3 | docker-compose 改名（edge のみ） | **完了** | root は既定探索依存のため移動せず |
| ~~Phase0-T4~~ | ~~`CLAUDE.md` を追跡対象に~~ | **取り下げ** | 機密を含むため意図的に除外 |
| Phase0-T9 | `tsbuildinfo` を追跡解除 | **完了** | commit `93fc678` |
| Phase1-T5 | `docs/imple/archive/` へ移動 | **完了** | 11 本を archive・3 本は未完了のため現役維持・参照 8 箇所修正 |
| Phase1-T6 | `insights` 参照の整理 | **完了** | 大半は意図的な記述。`logging-foundation-plan` の 2 箇所のみ注記 |
| R0-S1 | daemon トークン既定必須化 | **完了** | commit `8a4245f` |
| R0-S5 | multipart に Core ヘッダ | **完了** | commit `8a4245f`（回帰テスト付き） |
| R0-S6 | internalClients タイムアウト | **完了** | commit `8a4245f`（回帰テスト付き） |
| R0-S3 | loadTree 世代ガード | **完了** | commit `8a4245f` |
| R0-S7 | clientMetadataCache 上限 | **完了** | commit `8a4245f` |
| R0.5-S2 | セッションを httpOnly cookie へ | **完了** | commit `7fe2d5c` |
| R3 | スキーマ一元化 | **完了** | commit `261769b`・parity テスト付き |
| R4' | auth 適合テスト（共通化はしない） | **完了** | commit `9b36224`・ドリフト注入で検知を確認 |
| R1-pre | OAuth フローのテスト追加 | **完了** | 21 件。mutation 注入で有効性確認済み |
| R1 | core/httpServer 分割 | **完了** | 7,209→192 行（-97%）。16 モジュールへ分割 |
| R2 | sync-daemon 分割 | **機械的移動は完了** | 8,122→2,128 行（-74%）。残りは循環解消＝設計変更が必要 |
| ~~R4~~ | ~~services 共通パッケージ~~ | **取り下げ** | §4 R4 参照。R4' に置換 |
| R5+T8 | UI feature-first 化 | **大部分完了** | api.ts 2,469→112、pages/ 11,382→3,832、Analyser 1,884→56、Settings 2,236→1,905、Artifacts 3,451→3,108 |

---

## 6. 未解決事項

- ~~`HomePage` の並行編集~~: 解決。ユーザーが別プロセスに依頼した HomePage 刷新であることを確認し、レビューのうえ commit `75839be` として取り込んだ。レビュー時に、データ読込 effect の依存が `[]` → `[todayKey]` に変わったのに旧版が持っていたキャンセルガードが失われていた点（S3 と同型の退行）を修正済み
- §1 の行数などの数値は `8ae1585` 時点の HEAD 基準。HomePage 刷新（`75839be`）以降は UI 側の実測とわずかにずれる
