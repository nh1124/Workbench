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

### R1 — `workbench-core/httpServer.ts` 7,293 行の解体（3〜5 日）

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

### R2 — `sync-daemon/index.ts` 8,073 行の解体（3〜5 日）

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

### R5 — UI（4〜6 日、§2 の T8 と同時）

- `ArtifactsPage.tsx` 3451 行 → `ui/src/artifacts/` へ。state 39 個をまず `useReducer` か複数フックに割る。既に `ui/src/artifacts/hooks/` があるのでそこに寄せる
- `lib/api.ts` 2407 行 → `lib/api/<domain>.ts` へ分割。トランスポート（Core / daemon / フォールバック / リフレッシュ）を `lib/api/transport.ts` に集約。リフレッシュ後の失敗が元の 401 を再 throw してセッションを消す挙動（`933-1004`）もここで直す
- `SettingsPage.tsx` 2236 行 → セクションごとのコンポーネントへ

### 優先順位

```
✅ R0（バグ修正）→ ✅ R3（スキーマ一元化）→ ✅ R4'（auth 適合テスト）→ ✅ R0.5（httpOnly cookie）
  → ✅ Phase 0/1（掃除・ドキュメント整理）
  → R1（core, 要テスト先行）← 次 → R2（daemon）→ R5 + T8（UI）
```

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
| R1-pre | OAuth フローのテスト追加 | 未着手 | **R1 の前提** |
| R1 | core/httpServer 分割 | 未着手 | |
| R2 | sync-daemon 分割 | 未着手 | |
| ~~R4~~ | ~~services 共通パッケージ~~ | **取り下げ** | §4 R4 参照。R4' に置換 |
| R5+T8 | UI feature-first 化 | 未着手 | |

---

## 6. 未解決事項

- ~~`HomePage` の並行編集~~: 解決。ユーザーが別プロセスに依頼した HomePage 刷新であることを確認し、レビューのうえ commit `75839be` として取り込んだ。レビュー時に、データ読込 effect の依存が `[]` → `[todayKey]` に変わったのに旧版が持っていたキャンセルガードが失われていた点（S3 と同型の退行）を修正済み
- §1 の行数などの数値は `8ae1585` 時点の HEAD 基準。HomePage 刷新（`75839be`）以降は UI 側の実測とわずかにずれる
