# Workbench MCP Feedback Fixes Plan (2026-07)

Status: 実装完了(2026-07-08、commits d085ecb, 7792837 + skill追記)。§受入は本番反映後に実施
Last updated: 2026-07-08

背景: 2026-07-08、外部agent(ChatGPT)による実MCP運用フィードバック6件。
調査で原因を特定済み。Status legend は maintenance-loop-plan §1 と同一。状態更新は root のみ。

## 原因調査の結果

| # | 症状 | 原因(特定済み) |
|---|---|---|
| 1 | 複数語検索が0件 | `searchProjectIndex` が全語AND(`projectIndexStore.ts`)。かつ index の `summary_text` は本文の最初の非空行280字のみ(`projectContext.ts artifactSummary`)で、本文中のキーワードがindexに存在しない |
| 2 | projectNameにUUID | `artifactItemsStore.ts` の `resolveProjectContext`(書き込み時fallback)と tree集約の `COALESCE(NULLIF(MAX(project_name),''), project_id)`(読み取り時fallback)の2箇所 |
| 3 | 安全性チェックの断続ブロック | OpenAIクライアント側の前段判定。リクエストはWorkbenchに到達しておらず、サーバ側で制御不能 |
| 4 | Briefの「最新」参照が陳腐化 | briefは自由記述でArtifact更新と非連動(設計どおり)。検出パターンが未整備なだけ |
| 5 | section.update後の境界詰まり | `updateArtifactNoteSection` が置換本文の前後空行を正規化していない |
| 6 | rebuild後も検索が期待どおりにならない | 実体は#1。診断情報の不足で切り分け不能だった |

## 決定事項

```text
FB-D1 検索仕様(#1, #6)
- 既定を mode="any"(いずれかの語が path/title/summary/metadata に一致)へ変更し、
  一致語数の降順 → indexed_at降順 でスコア順に返す。従来のANDは mode="all" で明示指定。
- query正規化: NFKC(全半角統一) + trim。ILIKEにより大小文字は既に非依存。
- responseへ appliedQuery { tokens, mode, fields } を追加(何をどう検索したかの可視化)。
- HTTP(GET /projects/:id/index-entries)とMCP(projects.index.search)両方に mode? を追加。

FB-D2 index summaryの情報量(#1)
- artifactSummary(note)を「先頭段落 + 見出し(#〜######)一覧」の複合、上限500字へ拡張。
  deterministic原則は維持(LLM不使用)。本文キーワードの索引到達率を上げる。
- 既存entryへの反映は projects.index.rebuild で行う(受入手順に含める)。
- rebuild responseへ診断情報を追加: searchFields / summaryPolicy / completedAt。

FB-D3 projectNameの整合(#2)
- UUIDの代入を全廃: 書き込みfallbackは NULL、読み取りCOALESCEのfallbackも NULL。
- 既存データの修復: schema init に冪等cleanup
  (UPDATE ... SET project_name = NULL WHERE project_name = project_id) を追加。
- Core の tree/list facade は response 内の distinct projectId を projects service で
  live resolve し表示名を付与(解決不能は null。item.get と同じ「live resolve優先」原則)。

FB-D4 section境界の正規化(#5)
- updateArtifactNoteSection で置換本文をtrimし、前後を必ず空行(\n\n)で区切る。
  連続3行以上の空行は2行へ圧縮。見出し直前に空行を保証。

FB-D5 前段ブロック(#3) — サーバ変更なし
- workbench-maintenance / workbench-project skill に運用指針を追記:
  「client側safety blockはWorkbench障害ではない。同一引数で1回だけ再試行し、
  再失敗ならその旨を報告」。

FB-D6 brief鮮度(#4) — skillパターンで対応
- maintenance skill の点検パターンに「briefが参照する計画/文書の版・日付を、
  indexの該当entryの source_updated_at と突き合わせ、brief側が古ければ
  maintenance.flag(manual) + 更新草案」を追加。
- canonical/current フラグ等の構造的対応は必要が実証されるまで deferred。
```

## Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| FB-1 | `[implemented]` | projects/core | 検索: mode any(既定)/all + NFKC正規化 + matchedTokens + appliedQuery + MCP/HTTP schema + tests。並びはcursor整合のため indexed_at DESC を維持し、一致度は matchedTokens で返す方式を採用 |
| FB-2 | `[implemented]` | core | artifactSummary拡張(FB-D2) + rebuild診断フィールド + tests |
| FB-3 | `[implemented]` | artifacts/core | projectName UUID代入排除 + 冪等cleanup + core tree/list live resolve + tests |
| FB-4 | `[implemented]` | artifacts | section.update境界正規化 + tests |
| FB-5 | `[implemented]` | skill | FB-D5/FB-D6 のskill追記(root対応) |
| FB-R | `[implemented]` | root | レビュー・検証・commit・本番反映後の実地確認 |

## 受入(本番反映後)

1. `Jeremy 完了 6月末` 相当の複数語クエリが、rebuild後に該当ノートを返す(mode=any既定)。
2. appliedQuery がresponseに含まれ、0件時に検索条件を自己診断できる。
3. artifacts.tree.list の projectName が表示名または null になり、UUIDが現れない。
4. section.update後の本文で、置換部と次見出しの間に空行がある。
5. skillの再試行指針・brief鮮度点検が反映されている。
