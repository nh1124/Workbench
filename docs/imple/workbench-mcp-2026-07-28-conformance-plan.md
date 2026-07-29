# Workbench MCP 2026-07-28 仕様追従 調査・更改案

Status: 調査完了(2026-07-30)。実装未着手 — 方針承認待ち
Last updated: 2026-07-30

背景: MCP 仕様 revision `2026-07-28` が公開された(2026-07-28)。
前 revision は `2025-11-25`。本書は現行実装の追従度調査と更改案。
Status legend は maintenance-loop-plan §1 と同一。状態更新は root のみ。

## 結論(先に要点)

- **ワイヤ上の追従度は 0%**。現行 SDK は v1 系 `@modelcontextprotocol/sdk@^1.27.1` で
  `LATEST_PROTOCOL_VERSION = '2025-11-25'`。`2026-07-28` は 1 バイトも喋っていない。
- **一方でアーキテクチャ上の追従度は高い**。今回の最大の破壊的変更(セッション廃止・
  ステートレス化)は、現行実装が既に実質的に満たしている。
- **廃止(deprecated)による負債はゼロ**。Roots / Sampling / Logging / ping /
  resources / prompts / elicitation を一つも採用していない tools-only サーバであるため、
  今回の deprecation 群は全て N/A。
- したがって更改は**再設計ではなく「依存アップグレード + 認可の 2 点修正」**に収まる。
- 最大のリスクは技術ではなく**タイミング**。`2026-07-28` 対応 SDK は v2 系の
  **beta**(`@modelcontextprotocol/server@2.0.0`、公開 2026-07-28 = 2 日前)しかない。

## 現行実装の実態(調査結果)

| 項目 | 実態 |
|---|---|
| SDK | `@modelcontextprotocol/sdk@^1.27.1`(workbench-core, sync-daemon)。npm 最新の v1 は 1.30.0 |
| HTTP transport | `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`([routes/mcp.ts:131](../../services/workbench-core/src/routes/mcp.ts#L131)) |
| セッション | 皆無。POST ごとに `McpServer` + transport を新規生成。`Mcp-Session-Id` はコード・infra 設定のどこにも存在しない |
| GET /mcp | 既に 405 を返す([routes/mcp.ts:145](../../services/workbench-core/src/routes/mcp.ts#L145)) |
| stdio transport | `StdioServerTransport`([mcpServer.ts:46](../../services/workbench-core/src/mcpServer.ts#L46))、sync-daemon にも 1 つ |
| 公開機能 | tools のみ 160 個。resources / prompts / sampling / roots / logging / elicitation は**未使用** |
| tool 登録形式 | 160/160 が `server.registerTool(name, {config}, handler)` = v2 の必須形式と同一 |
| MCP client 実装 | 無し(`sdk/client` の import ゼロ)。client 側義務の仕様項目は全て N/A |
| 認可 | Core 自身が認可サーバ。CIMD 実装済み + DCR fallback |

## 仕様項目ごとの追従度

### 破壊的変更(Major)

| # | 仕様変更 | 追従度 | 備考 |
|---|---|---|---|
| 1 | セッション / `Mcp-Session-Id` 廃止 | **実質達成** | 既に stateless モード。サーバ側 state を一切セッションに置いていない |
| 2 | `initialize`/`initialized` 廃止、`_meta` へ protocolVersion 等 | 未達 | ワイヤ形式は SDK 依存。アプリ層に initialize 依存は無いため解除コストは無い |
| 3 | `server/discover` 必須(MUST) | **未達** | v2 SDK が提供。自前実装は不要 |
| 4 | GET + `resources/subscribe` → `subscriptions/listen` | N/A | resources を提供しておらず listChanged も emit していない |
| 5 | `ping` / `logging/setLevel` / `roots/list_changed` 削除 | N/A | いずれも未使用 |
| 6 | tasks を core 外の拡張へ(`io.modelcontextprotocol/tasks`) | 未採用(任意) | 後述 §長時間処理 |
| 7 | MRTR(`InputRequiredResult`)が server→client request を置換 | N/A | sampling/elicitation/roots 未使用 |
| 8 | 全 result に `resultType` 必須 | 未達 | v2 の codec が自動付与 |
| 9 | SSE 再開性 / `Last-Event-ID` 削除 | N/A | 未使用 |

### 軽微な変更(Minor)

| # | 仕様変更 | 追従度 | 備考 |
|---|---|---|---|
| 3 | tools/list の決定的順序(SHOULD) | **達成(副作用的)** | 登録順で固定。tool 集合も静的 |
| 4 | `Mcp-Method` / `Mcp-Name` ヘッダ必須化、`x-mcp-header` | 未達(影響小) | サーバは受容側。gateway routing 用 |
| 5 | `ttlMs` / `cacheScope` を list 結果に必須化 | **未達(実利あり)** | tool 160 個 = tools/list が大きい。キャッシュ効果が最も出る箇所 |
| 6 | resource not found `-32002` → `-32602` | N/A | resources 無し |
| 7 | RFC 9207 `iss` を認可レスポンスに(SHOULD) | **未達 = 実質的な欠落** | 後述 |
| 8 | DCR で `application_type` 指定要求 | 未達(軽微) | 当方の DCR endpoint は当該項目を無視 |
| 9 | client credential の issuer 束縛 | N/A | client 実装なし |
| 10 | inputSchema/outputSchema を JSON Schema 2020-12 全面許容へ緩和 | 影響なし | 緩和方向のため既存定義は有効 |
| 11 | `notifications/elicitation/complete` 削除 | N/A | 未使用 |
| 12 | エラーコード再割当(`-32020`〜`-32022`) | 未達 | v2 SDK 側 |
| 2 | OTel trace context(`traceparent` 等)を `_meta` に | 未達(任意) | 既存 logging-foundation と接続する余地あり |

### 廃止(Deprecated)

Roots / Sampling / Logging、HTTP+SSE transport、`includeContext` の
`thisServer`/`allServers`、DCR — **すべて未採用か、既に推奨側に立っている**。
特に DCR については、仕様が推す CIMD を既に実装済みで
`client_id_metadata_document_supported: true` を広告し、DCR を後方互換 fallback として
残す構成([oauth/clients.ts:413-457](../../services/workbench-core/src/oauth/clients.ts#L413-L457))は
新仕様の推奨姿勢とそのまま一致する。**この点は仕様より先回りしていた**。

## 修正が必要な箇所

### MCP-1 RFC 9207 `iss` の欠落(SDK 非依存・単独で実施可)

認可コード発行時のリダイレクトが `code` と `state` のみを載せており、`iss` が無い。

- [routes/oauth.ts:221-227](../../services/workbench-core/src/routes/oauth.ts#L221-L227) — `redirectUrl.searchParams.set("iss", issuer)` を追加
- [routes/oauth.ts:79-94](../../services/workbench-core/src/routes/oauth.ts#L79-L94) — AS metadata に
  `authorization_response_iss_parameter_supported: true` を追加

`iss` の値は `buildOAuthIssuer(req)`(metadata の `issuer` と同一値)を使う。両者が
一致しないと準拠クライアントが検証で落ちるため、必ず同じ関数から導出する。
新仕様下のクライアントは `iss` があれば検証が MUST なので、**先に metadata で
supported を広告してから付与するのではなく、両方を同一変更で入れる**。

### MCP-2 `ttlMs` / `cacheScope`(SDK 非依存で部分対応可)

tools/list に freshness hint を付ける。tool 集合はプロセス生存中不変なので
`ttlMs` は長め(例 300000)を取れる。`cacheScope` は tool 一覧自体はユーザ非依存だが、
**当方の tools/list は認証コンテキストで変わらない**ため `"public"` でも成立する。
ただし将来ユーザ別に tool を出し分ける可能性を残すなら `"private"` が安全側。
→ **`"private"` を採る**(共有中間層にキャッシュさせない)。

### MCP-3 SDK v1 → v2 移行(`2026-07-28` 準拠の前提条件)

パッケージ分割を伴う。

| v1 | v2 |
|---|---|
| `@modelcontextprotocol/sdk` (server) | `@modelcontextprotocol/server` |
| — | `@modelcontextprotocol/core`(Zod schema) |
| — | `@modelcontextprotocol/express` 等の framework adapter |

移行コストの実測見込み:

- **tool 登録 160 個: 低コスト**。既に v2 必須形式の `registerTool(name, {config}, handler)`。
  差分は `inputSchema` の raw shape を `z.object()` で包む点のみで、公式 codemod が対応。
  ただし analyser の 11 箇所は既に `z.object` を使っており二重ラップに注意。
- **entry point: 要書き換え**。`new McpServer()` + `transport` + `server.connect()` から
  `createMcpHandler`(HTTP)/ `serveStdio`(stdio)へ。対象は
  [routes/mcp.ts](../../services/workbench-core/src/routes/mcp.ts)、
  [mcpServer.ts](../../services/workbench-core/src/mcpServer.ts)、
  sync-daemon の [mcpServer.ts](../../services/sync-daemon/src/mcpServer.ts) の 3 箇所のみ。
- **handler の第 2 引数**: `extra` → `ctx`。当方は handler 引数に `extra` をほぼ使っておらず
  影響は小さい(要精査)。
- **後方互換**: v2 サーバは既定で 2025 系と `2026-07-28` の**両方を同一 endpoint で処理**する
  (`createMcpHandler` の `legacy: 'stateless'`)。既存クライアント(Claude Code / Codex /
  cowork)を切り捨てる flag day にはならない。
- **`server/discover` / `resultType` / エラーコード再割当**は SDK が引き受ける。

### MCP-4 長時間処理と tasks 拡張(任意・今回は見送り推奨)

`deep_research`、`images_generate`、`artifacts_download_to_client` の 3 系統が
それぞれ独自の `*_status` polling tool 対で長時間処理を表現している。仕様準拠の
`io.modelcontextprotocol/tasks` 拡張へ寄せる選択肢はあるが、現行方式も「普通の tool」
として完全に正当。**移行の必然性は無い**ため、v2 が安定してから別途検討する。

## 更改案(段階案)

```text
Phase 0 — 即時、SDK 非依存(推奨: 今すぐ着手)
  MCP-1 RFC 9207 iss + AS metadata の supported 広告
  MCP-2 tools/list の ttlMs / cacheScope
  MCP-3' DCR の application_type 受容(検証のみ、拒否はしない)
  → いずれも v1 のまま実施でき、新仕様方向に前進する。回帰リスク小。

Phase 1 — v2 beta の成熟待ち(着手条件付き)
  着手条件: @modelcontextprotocol/server が beta を抜ける、または
            2 週間以上 revert 級の不具合報告が無いこと。
  作業: codemod 適用 → entry point 3 箇所の書き換え → 型チェック
        → test:e2e:api → ローカル MCP で 160 tool の疎通確認
  検証の要点: 旧クライアント(2025 系)と新クライアントの双方が同一 endpoint で
              通ること。片側だけの確認で通したと判断しない。

Phase 2 — 本番 cutover
  analyser 移行(memory: analyser-migration-orchestration)と同じ 2 段階 cutover に倣う。
  本番 8 サービスは concurrently -k 束ねで単一障害点
  (memory: production-services-single-point-of-failure)。MCP 層の起動失敗が
  全滅に直結するため、ローカルで起動確認を取ってから反映する。

Phase 3 — 任意
  OTel trace context の _meta 伝播(logging-foundation-plan と接続)
  tasks 拡張の採否検討
```

## 判断が必要な事項

- Phase 1 の着手タイミング(beta を待つか、先行して取るか)。本書は**待つ**を推奨。
  理由: 現行 v1 は動作実績があり、`2026-07-28` を今すぐ喋れないことによる実害が
  現時点で無い(対応クライアントがまだ出回っていない)。
- `cacheScope` を `"public"` にするか `"private"` にするか。本書は `"private"` を推奨。

## 進捗ボード

| ID | 内容 | 状態 |
|---|---|---|
| MCP-0 | 仕様調査・追従度評価 | 完了(2026-07-30) |
| MCP-1 | RFC 9207 `iss` + AS metadata 広告 | 未着手 |
| MCP-2 | tools/list `ttlMs` / `cacheScope` | 未着手 |
| MCP-3' | DCR `application_type` 受容 | 未着手 |
| MCP-3 | SDK v1 → v2 移行(3 entry point + codemod) | 保留(beta 成熟待ち) |
| MCP-4 | tasks 拡張の採否 | 見送り |
| MCP-5 | OTel trace context | 見送り |

## 参照

- 仕様 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- リリース告知: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- v2 移行ガイド: `typescript-sdk/docs/migration/upgrade-to-v2.md`、
  `docs/migration/support-2026-07-28.md`
