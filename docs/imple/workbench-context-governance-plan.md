# Workbench Context Governance Plan (2026-07)

Status: 実装中
Last updated: 2026-07-08

背景: 「CLAUDE.md / brief は薄い入り口に保ち、詳細は必要時に参照する」方針の徹底。
2026-07-08 のギャップ分析(G1〜G5 + 導線)に基づく。maintenance-loop の運用ループを
「小ささを保つ」方向へ拡張する。状態更新は root agent のみ。

## 決定事項

```text
CG-D1 肥大検知(G1)
- brief-queue に derived reason `brief_oversized` を追加。
  条件: char_length(trim(brief)) > WORKBENCH_MAINTENANCE_BRIEF_MAX_CHARS(default 2000)。
- suggestedActions: ["slim_brief"](詳細を memory / notes へ移す提案)。
- brief_unmaintained と同一ソース(brief-queue)。両立はしない(空短 or 過大)。

CG-D2 briefの型(G2 + 導線)
- workbench-project skill に brief 推奨構成を規定:
  1) Purpose(1段落) 2) Always-on rules(数行の箇条書き)
  3) Pointers(「Xの時は <note/artifact/index query> を読む」)
  書かないもの: 手順(→notes)、参照本文(→artifacts)、耐久事実(→memory)、一時状態。
- brief は「薄い入り口」であり、Pointers 節が notes/artifacts への導線となる。

CG-D3 memory統合(G3)
- maintenance skill に consolidation パターンを追加:
  同一トピックの active memory が重複したら、統合した新規1本を agent_observed で
  下書きし、旧エントリは maintenance.flag(manual, note="consolidated into <id>")で
  キューへ載せる。archive の実行は人間が /maintenance UI で判断する
  (agentによる直接archiveは統合文脈では行わない)。

CG-D4 サイズ可視化(G4)
- 週次digestへ第5セクション「サイズ概況」を追加:
  brief_oversized / brief_unmaintained の該当project一覧(queueから取得、追加API不要)
  + reason別totals の前週比コメント。

CG-D5 リポジトリ導線(G5 + 導線)
- repo CLAUDE.md へ「エージェント導線」節を追加(ポインタのみ、5行以内):
  計画書=docs/imple(進捗ボード付き) / Workbench操作規律=.agents/skills/workbench-project /
  メンテナンス=.agents/skills/workbench-maintenance / 長文知識=Workbench notes・artifacts(MCP)。
- CLAUDE.md 自体の運用規約を1行明記: 「常時規範のみ。手順はskillへ、事実はmemoryへ」。
```

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| CG-1 | `[pending]` | projects/core/ui | `brief_oversized` reason(env閾値、suggestedActions、core SOURCE_REASONS/enum、UI filter反映) + tests |
| CG-2 | `[pending]` | skill | workbench-project へ brief 推奨構成(CG-D2)を追加 |
| CG-3 | `[pending]` | skill | workbench-maintenance へ consolidation パターン(CG-D3)と brief_oversized 対応を追加 |
| CG-4 | `[pending]` | skill/docs | digest 手順へ「サイズ概況」セクション追加(SKILL.md + maintenance-loop-plan §7.3) |
| CG-5 | `[pending]` | docs | repo CLAUDE.md へエージェント導線節 + 運用規約1行 |
| CG-R | `[pending]` | root | レビュー・検証・commit |

## 受入

1. 2,000字超のbriefを持つprojectが queue に `brief_oversized` で載り、UIのreason filterで絞れる。
2. skill に brief 構成規範があり、新規brief作成時にagentがPointers節を作る。
3. digestにサイズ概況が含まれる。
4. CLAUDE.md から skills / docs/imple / Workbench知識への参照が1ホップで辿れる。
