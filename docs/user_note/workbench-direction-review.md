# Workbench 方向性レビュー

Status: Review
Date: 2026-07-05
Reviewer: Claude (コードベース・設計文書・稼働中データを確認済み)

参照: `README.md`, `docs/project-agent-context-design.md`,
`docs/imple/workbench-local-client-sync-daemon-plan.md`,
`docs/imple/project-context-sync-export-plan.md`, 稼働中の12プロジェクト

---

## A. 変更が目指す理想の状態

Workbenchが「読ませる器」から「自律的に育つ第二の脳」になっている状態。具体的には:

1. **知識が自動的に鮮度を保つ** — 全リソースがlifecycle state と鮮度メタデータを持ち、
   陳腐化・矛盾・未確認の知識は自動的にレビューキューへ載る。放置された知識が
   静かに腐ることがない。
2. **信頼できる記憶が構造的に増え続ける** — agentの観察(`agent_observed`)が人間の
   軽量なレビューを経て `user_confirmed` へ昇格する経路が常時開いており、
   セッションを重ねるほどコンテキストの信頼密度が上がる。
3. **メンテナンスが差分駆動で回る** — 変更フィードを起点に、変わった部分だけを
   agentが定期的に整理する。全件スキャンは低頻度の修復操作に限定される。
4. **最適化判断がデータに基づく** — 何が読まれ、何が使われず、何が検索されて
   見つからなかったかが計測されており、「削るべき知識」「足すべき知識」を
   人間とagentが根拠を持って判断できる。
5. **取り込み口が開いている** — 雑多な入力(メモ、外部文書、将来的には操作記録)は
   inboxへrawとして入り、トリアージを経て適切なプロジェクトへ振り分けられる。
   Coreは太らず、capture側は周辺クライアントとして増やせる。
6. **人間のレビューコストが一箇所に集約される** — 週次ダイジェスト1本を見れば、
   変更の要約・要レビュー項目・昇格候補が揃っており、週1回の確認でループ全体が回る。

一言でいえば:

```text
変更発生 → 変更フィード → メンテキュー → 定期agent実行
  → 人間レビュー(週次・一箇所) → 昇格/破棄 → 変更フィード → …
```

このループが人手の常時介入なしに閉じていること。

## B. 現状の問題点

設計品質(authority分離・provenance・optimistic concurrency・Core単一境界)は高い。
問題は個々の機能ではなく、**ループが閉じていない**ことに集中している。

1. **全てpull型・agent起点** — agentがセッション内で読みに来たときだけ文脈が機能し、
   セッション外では何も起きない。知識の劣化を検知する主体が存在しない。
2. **昇格経路の欠落(最大の構造的欠落)** — MCP経由の書き込みは全て `agent_observed`
   固定で、`user_confirmed` へ昇格する手段がない。信頼できる記憶が増える仕組みが
   構造的に存在しない。
3. **状態・鮮度のメタデータ不足** — memoryの `status`/`authority`/`confidence`、
   indexの `content_hash`/`source_updated_at` はあるが、「いつ再検証すべきか」
   「最後にいつ確認されたか」を表す時間軸メタデータがなく、要レビュー項目を
   機械的に抽出できない。
4. **変更フィードがagentから見えない** — `sync_events` は存在するがdaemon専用で、
   MCPに露出していない。agentは「何が変わったか」を差分で知る手段がなく、
   メンテしようとすると全件を読むしかない。またイベントはbest-effortであり、
   単独ではメンテの根拠として完全性が保証されない。
5. **計測の不在** — context packのtruncation発生率、リソース別の参照実績、
   zero-hit queryが記録されておらず、「読ませているのに使われない知識」
   「欠けている知識」を特定できない。budget設計の妥当性も検証できない。
6. **取り込み口(inbox)とトリアージの不在** — 雑多な入力を一旦受けて振り分ける
   標準経路がなく、取り込みの摩擦が知識の欠落に直結する。
7. **規範と実データの乖離を検出できない** — 例: WorkbenchDevelopmentのbriefは
   「バグはmemoryのpitfallへ記録」と定めるが、該当memoryは検索でヒットしない。
   briefの陳腐化・未整備(英語1行のみのプロジェクトあり)を検知する仕組みがない。

## C. 変更提案

依存関係順。P1+P2が骨格であり、P2(昇格フロー)なしにP6(自動capture)を先行させると
低信頼データが蓄積するだけで第二の脳は育たない。

### P1: lifecycle metadata + maintenance queue(小規模)

- memory / index entry / note に追加:
  `lifecycle_state`(`raw`/`triaged`/`curated`/`verified`)、
  `review_after`(TTL。制度・価格など陳腐化の速いfact用)、
  `last_confirmed_at`、`review_reason`(`expired`/`conflict`/`source_changed`/`unconfirmed`)
- 横断read modelを1本追加:

  ```text
  GET /api/maintenance/queue    (MCP: maintenance.queue.list)
    → 全プロジェクトから要レビュー項目を集約
      (state=raw, review_after超過, 矛盾検出, 長期未確認のagent_observed, brief未整備)
  ```

### P2: 昇格フロー(中規模・UI含む)

- レビューキューUI: maintenance queueを表示し、項目ごとに
  承認(`user_confirmed`へ昇格)/ supersede / archive / 破棄を選択できる。
- 昇格はUI経由(true user path)に限定し、MCPからの自動昇格は引き続き禁止
  (design doc §11 の先送り判断を維持)。

### P3: 変更フィードのMCP露出 + メンテナンスskill(小〜中規模)

- consumerごとのcursor管理(daemon用とメンテagent用を分離)。
- MCP tool追加(例: `sync.changes.pull`)。`project_context` domainの
  invalidationイベント(`changed: ["brief"|"memory"|...]`)をメンテ対象特定に流用。
- best-effort対策として、差分駆動(高頻度)+ 全件スイープ(低頻度、
  `projects_index_rebuild` と同格の修復扱い)のハイブリッドとする。
- `workbench-maintenance` skillを `workbench-project` とは別に新設する。
  読む文脈と権限が異なるため(横断read + supersede提案が主で、
  通常業務の書き込みをしない)。

### P4: usage_events による計測(小規模・P1〜P3と並行可)

Coreが単一gatewayである利点を回収する。ミドルウェア1箇所で `usage_events` に記録:

1. truncation発生率 — `context.get` でどのsectionが切られるか(budget検証)
2. リソース別参照回数 — indexで選ばれ本文まで開かれたか(未使用知識の発見)
3. zero-hit query — index検索0件のquery文字列(**欠けている知識の直接シグナル**)

最適化ロジックは作らない。計測結果をメンテキューの入力に加えるだけで、
「未使用memoryのarchive提案」「欠落知識の追加提案」が人間レビュー付きで回る。

### P5: 週次ダイジェスト自動生成(小規模、P1+P3+P4依存)

- 変更フィードを期間集約し、変更要約 + 要レビュー項目 + 昇格候補 + 計測サマリを
  1本のnoteとして自動生成。人間のレビューを週1回・一箇所に集約する。

### P6: capture client(大規模・要議論、P1+P2安定後)

- PC操作記録などの常時captureは**Workbench Coreに入れない**。
  責任範囲の肥大、プライバシーとデータ量の質的差異、Core単一境界の維持が理由。
- sync-daemonと同格の外部「capture client」として実装し、要約済み結果のみを
  inbox(defaultプロジェクト or 専用Inboxプロジェクト)へ `state=raw` で投入する。
  Workbench側の変更は不要。「周辺機器は増やしてよい、Coreは太らせない」を守る。

---

以下、当初レビューの5論点別の詳細検討。

## 1. 変更ログによる差分メンテ(論点1)

**結論: 新規構築は不要。`sync_events` がほぼそのまま変更フィードとして使える。**

sync-daemon計画で実装済みの `sync_events` + `GET /api/sync/pull`(cursor付き)は、
まさに「変更部分だけを見る」ための基盤である。daemonのために作ったものだが、
メンテナンスagentを**もう一つのsync consumer**として位置づければよい。

必要な追加は小さい:

- consumerごとのcursor管理(daemon用cursorとメンテagent用cursorの分離)
- 変更フィードのMCP露出(例: `sync.changes.pull`)。現状MCPからは差分が見えない
- `project_context` domainのinvalidationイベント(`changed: ["brief"|"memory"|...]`)を
  メンテ対象の特定に流用する

**注意点が一つ**: 現実装のsyncイベントは各所で「best-effort」と明記されている。
メンテナンスの根拠を取りこぼすと「壊れているのに検知されない」状態になるため、
差分駆動(高頻度・安価)+ 全件スイープ(低頻度・rebuild APIと同格の修復扱い)の
ハイブリッドを推奨する。既に`projects_index_rebuild`で「drift修復」の概念があるので、
思想的にも一貫する。

## 2. raw層とメンテ範囲の自動決定(論点2)

**結論: 「rawという保存場所」ではなく「rawという状態」として採用すべき。疑問は正しい。**

raw専用ストレージを作ると、正本がどこかが曖昧になり、Artifact本文を複製しないという
既存決定(D-001)と衝突しかねない。代わりに:

- 取り込み口(inbox)= defaultプロジェクト or 専用Inboxプロジェクト
- リソースに lifecycle state を持たせる(論点3と統合): `raw → triaged → curated → verified`
- 「rawの存在がメンテ範囲を決める」は「`state=raw` のリソース一覧がメンテキューになる」と
  読み替える

こうするとメンテ範囲の決定は「raw層のスキャン」ではなく
「変更フィード(論点1)+ 状態クエリ(論点3)」の合成になり、専用機構が要らない。

## 3. リソースの状態メタデータ(論点3)

**結論: 最も費用対効果が高い。既存スキーマへの追加だけで成立する。**

既にある部品: memory は `status`(active/superseded/archived)+ `authority` + `confidence`、
index entry は `content_hash` + `source_updated_at`。足りないのは「時間軸」と「レビュー要求」。
追加フィールドと maintenance queue の詳細は提案P1を参照。

これが**メンテナンスagentの入力**かつ**人間の週次レビューの入力**になる。
設計文書が意図的に先送りした「modelによるmemory自動昇格」(§11)は先送りのままでよいが、
`agent_observed → user_confirmed` の**人間による昇格UI(レビューキュー)**は必要。
昇格経路が存在しない限り、信頼できる記憶が構造的に増えない。これが現設計の最大の欠落。

## 4. メタデータ測定・コンテキスト利用の計測(論点4)

**結論: Coreが単一gatewayである利点をここで回収する。最初は3指標だけでよい。**

全てのagentアクセスがCoreを通るため、計測はCoreのミドルウェア1箇所で済む。
指標の詳細は提案P4を参照。

「エージェントが最適化判断できるように」という方向は正しいが、最適化ロジックを
先に作らないこと。まず計測結果をメンテキュー(論点3)の入力の一つにするだけで、
「使われないmemoryのarchive提案」「欠落知識の追加提案」が人間レビュー付きで回る。

## 5. ダイジェストとPC操作記録(論点5)

**結論: 週次/日次ダイジェストはsyncフィードの再利用で安価に実現できる。
PC操作記録はWorkbenchの責任範囲外に置くべき — ただし排除ではなく境界の設計で解決する。**

- ダイジェスト: 変更フィード(論点1)を期間指定で集約 → noteとして自動生成。
  レビューキュー(論点3)と昇格候補を同じnoteに載せれば、人間のレビューコストが
  週1回・一箇所に集約される。インフラは全て既存。
- PC操作記録: Workbench Coreに入れるべきではない。理由は
  (a) 責任範囲の肥大(ストレージ/文脈提供 vs 常時監視は別問題)、
  (b) プライバシーとデータ量の質が既存リソースと桁違い、
  (c) Core単一境界の思想と無関係な常駐captureが混ざる。

  ただしアーキテクチャ上の受け皿は既にある: **sync-daemonと同格の「capture client」**
  として外部に置き、要約済みの結果だけをinbox(論点2)へrawとして投入する形なら、
  Workbench側は何も変えずに済む。「周辺機器は増やしてよい、Coreは太らせない」が
  この設計の一貫した強みであり、それを守る解がある。

## 6. その他気づいた点

- WorkbenchDevelopmentプロジェクトのbriefは「バグはmemoryのpitfallに記録」と定めているが、
  実際のmemoryは検索でヒットしなかった。**brief(規範)と実データの乖離**はメンテナンス
  agentが検出すべき代表パターンであり、最初のテストケースに適している。
- 12プロジェクトのbrief品質にばらつきがある(英語1行のみ vs 構造化済み)。
  P1のメンテキューに「brief未整備」も含めると育成が進む。
- skill(`workbench-project`)は操作規律の記述として優れている。メンテナンス用に
  別skill(`workbench-maintenance`)を分けることを推奨。
