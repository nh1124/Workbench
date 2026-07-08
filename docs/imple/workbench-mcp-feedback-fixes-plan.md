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

---

# Phase 2 (2026-07-08 再レビューの残課題)

Status: `[in-progress]` — 2026-07-09 Owner承認済み。再レビューで「検索が本文完全一致を取り逃す」
「item.get の projectName が省略される」の2点が優先残課題と判定された。

## 決定事項(案)

```text
FB2-D1 本文検索(#再レビュー1、本命)
- project_index_entries へ content_text TEXT(検索専用、先頭20,000字でbound)を追加し、
  index維持経路(artifacts note/file title等、mindmap node text、wbs項目名)で投入する。
- 検索fieldsへ "content" を追加(ILIKE。any/all両mode対象)。
- content_text は検索専用であり、search/list/context のresponseへは一切含めない
  (context budgetと「本文はdomain toolで読む」原則を維持)。
- 既存entryへの反映は projects.index.rebuild(受入手順に含める)。
- 補足: 「index はArtifact本文を複製しない」という当初方針の変更にあたるが、
  content_text は正本ではなく再構築可能な派生キャッシュ(rebuildで修復)であり、
  単一ユーザー・数百entry規模では容量影響は無視できる。フォールバック方式
  (検索弱時にartifacts/notesサービスへfan-out)は複雑さの割に網羅性が劣るため不採用。

FB2-D2 一致度順ソート(#再レビュー1の順位付け)
- q指定時の並びを score(matchedTokens) DESC → indexed_at DESC → id DESC へ変更。
- cursorへscoreを含めた複合タプル比較((score, indexed_at, id) < ($1,$2,$3))で
  ページングとの整合を取る(全キーDESCなのでタプル比較で成立)。
- 一般語への重み付け(IT/Lab等)は行わない(scoring導入後の効果を見て再検討)。

FB2-D3 item.get の projectName 統一(#再レビュー2)
- Core の artifactsClient.getItem に tree と同じ live resolve を適用し、
  projectName を常にキーとして含める(解決不能時は null。省略はしない)。
- artifacts service 側の応答も project_name が NULL のとき undefined(キー省略)
  ではなく null を返すよう統一(:219, :809)。
- note create/update等の単一item応答も同じresolverを通す。

FB2-D4 過去データのMarkdown境界 — 対応しない(Owner判断)
- 旧不良は該当セクションを次に section.update した時点で正規化される(自然治癒)。
- 一括migration・保存時全体正規化は、agentが意図しない箇所の書き換えリスクが
  上回るため不採用。必要になった項目のみ手動/agent操作で修復する。

FB2-D5 brief陳腐化検出のテスト方法(#再レビュー5への回答)
- 現行は「maintenance skill による点検パターン」であり自動比較ではない(仕様どおり)。
- 検証は skill forward-test シナリオへ追加: テストprojectに古い版参照のbriefと
  新しいPlan artifactを作り、skillが flag + 更新草案を出すことを確認する。
- 自動整合性チェック(queue化)は skill 運用で不足が実証されたら再検討(deferred)。
```

## Phase 2 Progress Board

| ID | Status | Scope | Task |
|---|---|---|---|
| FB2-1 | `[in-progress]` | projects/core | content_text 追加 + index維持経路での投入 + 検索fields拡張 + rebuild反映 + tests |
| FB2-2 | `[in-progress]` | projects | score順ソート + score入り複合cursor + tests |
| FB2-3 | `[in-progress]` | artifacts/core | item.get live resolve + projectName null統一 + tests |
| FB2-4 | - | - | 対応しない(FB2-D4) |
| FB2-5 | `[in-progress]` | skill/docs | forward-testシナリオへbrief陳腐化ケース追記 |
| FB2-R | `[pending]` | root | 承認後: レビュー・検証・commit・本番反映・再受入 |

## Phase 2 受入(本番反映 + rebuild後)

1. `Jeremy's IT Lab 全63日完走` が該当進捗ノートを返し、本文一致がヒットする。
2. q指定時、matchedTokensの多い結果が先頭に並ぶ。
3. artifacts.item.get が常に projectName キーを持つ(表示名 or null)。UUIDは現れない。
