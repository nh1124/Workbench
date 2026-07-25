# Workbench Logging Foundation Plan (2026-07)

Status: `[approved]` — 2026-07-14 Owner承認（自前基盤 / 各サービス保持 / MCP非公開）
Last updated: 2026-07-14

背景: 現行のログは全サービス `console.*` 直書きのみで、本番（リモート Rocky サーバ）では
tmux スクロールバックにしか残らない。auto_update.sh の再起動で障害時ログが消え、
参照には「SSH → tmux attach → スクロールバック発掘」が必要でデバッグが遅い。
Owner 方針: (1) pm2 等の外部プロセス基盤に依存せず自前で持つ、(2) core 集約はせず
各サービスがファイルへ書く、(3) MCP へのログ公開はしない（ファイル参照 + ssh 1コマンド）。

## Owner決定(2026-07-14)

1. **ログ生成・保存は自前実装**。pm2 / systemd 等のプロセスマネージャには依存しない。
2. **core 集約はしない**。各サービスが共通 `logs/` ディレクトリへ自分で書く
   （集約はランタイム結合ではなくファイルシステム層で実現）。
3. **MCP / HTTP でのログ公開はしない**。参照はファイル直読み（ローカル）と
   非対話 ssh 1コマンド（本番）。セキュリティ露出面とツール混同を避ける。

## 決定事項

```text
LG-D1 共有 logger パッケージ services/logging（package name: @workbench/logging）
- 依存ゼロ・ビルド不要の plain ESM JavaScript + 手書き index.d.ts。
  理由: tsx dev / 各サービスの tsc build / artifacts Docker npm ci との
  ビルド順序・lifecycle 結合を作らないため（TS ソース + prepare 方式は
  runtime stage の --omit=dev で devDep tsc が無く破綻する）。
- 出力: JSON Lines。1行 = {ts(ISO8601), level, service, msg, ...fields}。
  fields 中の Error は {name, message, stack} に序列化。
- 出力先: <repo root>/logs/<service>-YYYY-MM-DD.jsonl。
  repo root は cwd から package.json の workspaces フィールドを上方探索。
  WORKBENCH_LOG_DIR で明示上書き可（Docker では /app/logs を指定）。
- ローテーション: 日付別ファイル名（ローテーションデーモン不要）。
  logger 生成時 + 24h 毎に自サービスの WORKBENCH_LOG_RETENTION_DAYS
  (default 14) 日超のファイルを削除。
- レベル: debug|info|warn|error。LOG_LEVEL で閾値制御（default info）。
- コンソールミラー: stderr へ人間可読1行を出力（tmux での現行視認性を維持、
  MCP stdio モードの stdout プロトコル汚染を防ぐため stdout は使わない）。
  WORKBENCH_LOG_CONSOLE=0 で無効化。
- 堅牢性: logging がサービスを殺さないこと。logs/ 書込不能時は stderr に
  一度だけ警告してコンソールミラーのみで継続。write エラーも同様。

LG-D2 プロセスレベルハンドラ（installProcessHandlers）
- uncaughtException: 同期書込（appendFileSync）で stack を記録 → exit(1)。
- unhandledRejection: 同期書込で記録 → rethrow（Node 20 default の
  クラッシュ挙動を変えない。挙動変更は本計画のスコープ外）。

LG-D3 requestLogger ミドルウェア（Express 互換、型は構造的に定義し
  @types/express 非依存）
- res "finish" で {method, path, status, durationMs, requestId} を info 記録。
- requestId: 受信 x-request-id があれば採用、なければ randomUUID。
  res.locals.requestId / res.locals.log(child logger) に格納。
- /health 系はスキップ。core→内部サービスへの x-request-id 伝播
  （core 側 fetch 呼び出し点への注入）は将来スコープ（LG-F1）。

LG-D4 各サービス統合方針
- 対象: workbench-core, notes, artifacts, tasks, projects, images,
  mindmaps, wbs, insights（現 analyser。src のみ。__tests__/scripts/dist は対象外）。
- sync-daemon は対象外（クライアント機で動くためサーバ logs/ の前提が
  成り立たない。必要になれば別計画）。
- 複数ファイルから使うサービス（workbench-core, tasks）は src/logger.ts に
  シングルトンを置き、各ファイルはそれを import。
- console.* は logger.* へ置換。レベル対応: console.log→info,
  console.info→info, console.warn→warn, console.error→error。
  ただし workbench-core の OAuth 冗長ログ（token request / PKCE check /
  resource check 等の console.info）は debug へ格下げ。
- handleError 系（tasks 等）は message のみでなく Error オブジェクトを
  fields として渡し stack を記録する。

LG-D5 infra / 運用
- .gitignore に /logs/ を追加（auto_update.sh の dirty チェックに
  引っかからないよう必須）。
- initialize_system.sh / .bat で mkdir -p logs（docker bind mount が
  root 所有で先に作ってしまい、ホスト側 node サービスが書けなくなる
  順序問題の防止）。
- docker-compose の artifacts: ./logs:/app/logs を bind mount、
  WORKBENCH_LOG_DIR=/app/logs、logging driver json-file の
  max-size/max-file を設定。Dockerfile は builder / runtime 両 stage に
  services/logging を COPY（ビルド不要なので COPY のみ）。
- infra/logs_tail.sh を新設: logs_tail.sh <service|all> [-n N]
  [--level LVL] [--date YYYY-MM-DD] [-f]。jq 非依存（grep ベース）。
  本番参照例: ssh rocky@... "~/Workbench/infra/logs_tail.sh tasks --level error"
- workbench.env.example に WORKBENCH_LOG_DIR / LOG_LEVEL /
  WORKBENCH_LOG_RETENTION_DAYS / WORKBENCH_LOG_CONSOLE を追記
  （コメントとして。ポート同期対象ではない）。

LG-F1 将来スコープ（本計画では実装しない）
- core→内部サービスの x-request-id 伝播（core 内 fetch 呼び出し点が
  分散しているため、別途 internal client helper の集約と同時に行う）。
- SSH レス参照が本当に必要になった場合の internal x-api-key 限定
  HTTP エンドポイント（MCP ツールリストには載せない）。
```

## Progress Board

**状態更新は root agent のみ。** legend: `[ ]` todo / `[~]` in progress / `[x]` done

| # | タスク | Status |
|---|--------|--------|
| P1 | services/logging パッケージ新設（index.js / index.d.ts / package.json、root workspaces は services/* で自動包含） | `[x]` |
| P2 | requestLogger / installProcessHandlers 実装（P1 に同梱） | `[x]` |
| P3 | workbench-core 統合: src/logger.ts、httpServer.ts の console 置換 + OAuth debug 格下げ、projectContext.ts ほか周辺ファイル | `[x]` |
| P4 | 内部 8 サービス統合（notes / artifacts / tasks / projects / images / mindmaps / wbs / insights〔現 analyser〕、tasks は store 系含む） | `[x]` |
| P5 | infra: .gitignore、initialize_system、docker-compose、artifacts Dockerfile、logs_tail.sh、env example 追記 | `[x]` |
| P6 | 検証: 全 workspace tsc --noEmit、logger 単体+実 Express スモーク（ファイル生成・レベル・ローテ削除・requestId・/health除外）、tasks 139/139・core 77/77 pass | `[x]` |

実装メモ（2026-07-14）:
- core の usageEventsStore.test.ts は console.warn スパイを logger.warn スパイに変更
  （警告経路が logger 経由になったため）。
- 本番反映時は `npm install` 後にサービス再起動（auto_update.sh の通常フローで可）。
  artifacts はイメージ再ビルドが必要（start_services.sh の --build で対応済み）。

## 検証手順

1. `npm install`（workspace link 生成）→ `node --check services/logging/src/index.js`
2. 各サービス workspace で `npx tsc --noEmit`
3. スクラッチスクリプトで createLogger → logs/<svc>-<date>.jsonl 生成、
   LOG_LEVEL フィルタ、Error stack 序列化、retention 削除、requestLogger の
   finish ログを確認
4. `npm test --workspace services/tasks`
5. （本番反映後）`infra/logs_tail.sh core -n 50` で参照確認
