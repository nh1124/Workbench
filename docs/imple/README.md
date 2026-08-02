# 実装計画 / Implementation plans

着手前に該当計画書を読むこと（[CLAUDE.md](../../CLAUDE.md) 参照）。各計画書は末尾に進捗ボードを持つ。

完了した計画書は [archive/](archive/) に移動する。**進捗ボードに `[pending]` / `[in-progress]` が
1 つでも残っているものは archive しない** —— 未完了の作業が埋もれるため。

## 現役の計画書

### 横断 / 整理

| 計画書 | 内容 |
|---|---|
| [workbench-cleanup-refactor-plan.md](workbench-cleanup-refactor-plan.md) | リポジトリ整理とリファクタリング（2026-07 調査）。セキュリティ修正は完了、大物分割が残 |
| [logging-foundation-plan.md](logging-foundation-plan.md) | 共通ロガー `@workbench/logging` |

### Analyser

| 計画書 | 内容 |
|---|---|
| [workbench-analyser-service-plan.md](workbench-analyser-service-plan.md) | Analyser サービス本体 |
| [workbench-analyser-capture-v2-plan.md](workbench-analyser-capture-v2-plan.md) | キャプチャ v2 |
| [workbench-analyser-improvement-proposal.md](workbench-analyser-improvement-proposal.md) | 改善提案（IW-1..3） |
| [workbench-analyser-migration-runbook.md](workbench-analyser-migration-runbook.md) | insights → analyser 移行手順（本番 cutover 済み） |
| [workbench-analyser-operations-runbook.md](workbench-analyser-operations-runbook.md) | 運用手順 |
| [workbench-agentskills-sync-maintenance-plan.md](workbench-agentskills-sync-maintenance-plan.md) | AgentSkills 同期 |
| [workbench-maintenance-loop-plan.md](workbench-maintenance-loop-plan.md) | メンテナンスループ。**残: P3-8 forward-test（live 環境が必要）** |

### ローカルクライアント / 同期

| 計画書 | 内容 |
|---|---|
| [workbench-local-client-sync-daemon-plan.md](workbench-local-client-sync-daemon-plan.md) | sync-daemon |
| [workbench-capture-client-plan.md](workbench-capture-client-plan.md) | キャプチャクライアント |
| [project-context-offline-writes-plan.md](project-context-offline-writes-plan.md) | オフライン書き込み |
| [project-context-sync-export-plan.md](project-context-sync-export-plan.md) | context の同期エクスポート |

### ネイティブデスクトップ

| 計画書 | 内容 |
|---|---|
| [workbench-native-variant-apps-plan.md](workbench-native-variant-apps-plan.md) | Tasks / Notes / Artifacts の専用アプリ化、native UI の web からの独立、daemon の参照カウンタ。**冒頭に現状インデックスあり** |
| [workbench-native-daemon-residency-plan.md](workbench-native-daemon-residency-plan.md) | 常駐の主体を main から daemon へ反転。**variant 分割の完了後に着手** |

### ドメイン

| 計画書 | 内容 |
|---|---|
| [tasks-ui-spec.md](tasks-ui-spec.md) | Tasks UI 仕様 |
| [tasks-ui-fixes-2026-07-plan.md](tasks-ui-fixes-2026-07-plan.md) | Tasks UI 修正（2026-07） |
| [lbs-full-integration-plan.md](lbs-full-integration-plan.md) | LBS 統合。W7 は「本番移行は実行不要」と実地調査で確定（§7.1）。archive 候補 |
| [wbs-implementation-progress-plan.md](wbs-implementation-progress-plan.md) | WBS。最終検証とレビューが進行中 |
| [workbench-mcp-feedback-fixes-plan.md](workbench-mcp-feedback-fixes-plan.md) | MCP フィードバック修正。**残: FB2-R の本番反映と再受入** |

## 未完了の作業（archive 判定時に検出）

archive 対象を選ぶ際に、以下が未完了として残っていることを確認した。埋もれないようここに再掲する。

- ~~**`lbs-full-integration-plan` W7**~~ — **解決（2026-07-26）**。本番調査の結果、レガシーデータは既に
  本番 tasks DB に存在し、移行 CLI の実行は現行データを 2 ヶ月前の値で上書きするだけと判明したため
  「実行不要」で完了。根拠は同計画書 §7.1。
- **`workbench-mcp-feedback-fixes-plan` FB2-R** — commit 済み（95191ce, c47c69a）だが本番反映（push）と
  再受入・rebuild が残っている。
- **`workbench-maintenance-loop-plan` P3-8** — skill forward-test。サービス起動と MCP 接続が要るため
  live 環境で実施する。
