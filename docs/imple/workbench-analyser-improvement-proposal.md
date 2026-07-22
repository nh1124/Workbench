# Workbench Analyser 改善提案書 (2026-07)

Status: `[proposal]` — 2026-07-21 起票（Owner レビュー用）
Related: [workbench-analyser-service-plan.md](workbench-analyser-service-plan.md)（実装正本）

移行完了後の Analyser について、Owner および独立レビューで検出された欠陥 8 件
（P1×4 / P2×4）を、**2 つの改善の柱**に束ねて設計・優先度・工数とともに提案する。
本書は提案のみ。実装は Owner の承認後、フェーズ単位で着手する。

## 0. 2 つの柱（Owner 優先事項）

- **柱 A: 収集データの活用** — machine が集めた活動データと MCP/UI アクセス観測が、
  観測→解析→提案のループで**実際に使える**状態になっていない。収集設定が daemon に
  効かず、observation に resource 参照が無く、集計 timezone がずれ、machine 同定が
  不安定なため、「集めたのに参照・活用できない」状態を生んでいる。**最優先。**
- **柱 B: skill の独自保持** — routine は `skill_key` 文字列だけを持ち、Analyser は
  skill 本文を保持しない。正本 skill が消えると routine が壊れ、Analyser 単体では
  復元も検知もできない。**次点。**

その他、export の冪等性・予約残骸（P2）を横断課題として扱う。

## 1. 指摘一覧（現状の欠陥）

| ID | 柱 | 分類 | 優先 | 概要 | 該当箇所 |
|---|---|---|---|---|---|
| A1 | A | correctness | P1 | MCP/UI アクセス観測の `resourceRefs` が常に空。focused read に到達不能 | analyserAccessInstrumentation.ts:259, 334 |
| A2 | A | correctness/privacy | P1 | Analyser の収集設定が daemon の**取得**に反映されず、OFF にしても収集継続。screenshot(local_only) は ingest でも止められない | capture/manager.ts:80, capture/uploader.ts:116 |
| A3 | A | correctness | P1 | raw metadata が source/action 別 allowlist でなく blacklist。`prompt`/`documentBody`/`content` 等で本文を最大 2000 字/キー保存でき「メタデータ+参照のみ」契約を破れる。operation detail も同様 | types.ts:169, observations.ts:103, operations.ts:31 |
| A4 | A | correctness | P1 | `local_file` 収集の producer が存在しない。localRootAllow/deny・excludePatterns は保存されるだけで ingest filter は project/resourceType のみ評価。設定一式が実質無効 | AnalyserPage.tsx(Settings), observations.ts:94 |
| A5 | A | correctness | P2 | Activity の日付範囲・集計が UTC 基準。UI はローカル日付を送るが SQL は `occurred_at::date` + DB timezone。Asia/Tokyo で最大 9h ずれ、daily/7/14/30 日表示が誤る | AnalyserPage.tsx:48, observations.ts:279 |
| A6 | A | correctness | P2 | observation ingest が machine の所有権・存在を検証しない（FK 無し）。daemon は machine ID を永続キャッシュするため DB 復元後も stale ID を送り、machine override 不適用・UI 一覧と不一致 | db.ts:115, observations.ts:155, uploader.ts:95 |
| C1 | 横断 | correctness | P2 | export の dedupe hash が `targetKind + content` のみで projectId/path を無視。別 Project/別 path への再 export が新規保存先を作らず旧 target を成功として返す | analyserExport.ts:208 |
| C2 | 横断 | robustness | P2 | export は publication 予約→Note/Artifact 作成の順。作成/finalize 失敗時の予約解除・期限が無く、空 targetId を poll し続け 503 が永続化 | analyserExport.ts:217, 303 |
| B1 | B | enhancement | P2 | routine が skill 本文を保持せず、正本 skill 削除を検知・復元できない | db.ts(analyser_routines), stores/routines.ts |

分類: **correctness/privacy** は契約・仕様違反（要修正）、**enhancement** は機能拡張。

---

## 2. 柱 A: 収集データの活用

### A1. アクセス観測に resource-ref extractor を追加（P1・最重要）

**現状**: `analyserAccessInstrumentation.ts` は MCP tool 実行と HTTP route の両方で
`resourceRefs: []` を固定。metadata に tool/route 名は残るが、どの Note/Artifact/Project を
触ったかの参照が無い。`workbench-analyser-cycle` skill は「observation の resourceRefs を
グループ化して focused read する」設計なので、**アクセス観測からは解析対象へ到達できない**。

**提案**: tool/route ごとの **resource-ref extractor レジストリ**を導入する。
- MCP 側: `toolName → (args) => ResourceRef[]` のマップ。例:
  - `notes.get`/`notes.update` → `{service:"notes", resourceType:"note", resourceId: args.noteId}`
  - `artifacts.item.get`/`artifacts.item.update`/`artifacts.item.move` → `{service:"artifacts", resourceType:"artifact_item", resourceId: args.itemId, pathSnapshot: args.path?}`
  - `projects.context.get`/`projects.get` → `{service:"projects", resourceType:"project", resourceId: args.projectId}`
  - tasks/mindmaps/wbs も同様に主 ID を1件抽出。
  - 未登録 tool は空のまま（後方互換・fail open しない）。
- HTTP 側: 正規化 route（既に UUID→`:id`）から抽出。例 `POST /api/notes/:id` → `{notes, note, <id from path>}`。path の `:id` セグメントを実 UUID で復元して詰める。
- **引数本文は転送しない**。ID/パスなど参照のみを allowlist で抽出（A3 と整合）。

**効果**: workbench_change（projector 由来・既に refs 有り）に加え、agent/UI のアクセス観測
からも focused read が可能になり、「誰がどのリソースをいつ触ったか」を起点に解析できる。

**工数**: M（Core 1 ファイル + extractor マップ + テスト）。**柱 A の要。最優先で実装推奨。**

### A2. サーバー収集ポリシーを daemon の取得段階へ反映（P1・privacy）

**現状**: `CaptureManager.startFromConfig` はローカル `config.enabled`（=foregroundAppCapture）
のみで起動判定。サーバー側 effective policy を見るのは uploader の
`foregroundAppUpload` gate だけ。よって Analyser UI で foreground/windowTitle/screenshot を
OFF にしても、ローカル設定が ON なら**取得は継続**する。特に screenshot(local_only) は
upload されないため ingest gate でも止まらず、UI の説明（「このPC上の収集設定」）と実挙動が
乖離する。

**提案**: daemon が effective server policy を定期取得し、**「ローカル設定 AND サーバー設定」の
厳しい方**で取得自体を gate する（stricter-wins を取得段階へ前倒し）。
- CaptureManager に effective policy provider を注入（uploader が既に 60s cache で取得中の
  `/api/analyser/settings/effective` を共有）。
- foreground サンプリング: `local.enabled && server.foregroundAppCapture !== "off"` で supervisor 起動/停止。
- window title: `server.windowTitleCapture` が false なら取得段階で空（既にローカル
  windowTitleCapture で空白化しているが、サーバー設定も反映）。
- screenshot: `local.screenshotsEnabled && server.screenshots !== "off"` で scheduler 起動/停止。
- policy 変更を検知したら次 tick で supervisor/scheduler を再構成。取得不能時は fail closed
  （取得停止側に倒す）。
- **代替（最小策）**: 上記が過大なら、Analyser Settings UI から foreground/windowTitle/
  screenshot の**トグルを一旦撤去**し「これらは各 PC の daemon 設定で管理」と明記して
  乖離を解消する。※ Owner の「収集データ活用」方針とは逆行するため本命は上記の反映実装。

**工数**: M〜L（daemon capture 系の状態管理変更 + テスト）。**privacy 契約に直結、P1。**

### A3. metadata / operation detail を allowlist serializer 化（P1・privacy）

**現状**: `observationInputSchema` は任意 action・任意 scalar metadata を受理し、
`sanitizeMetadata` は「秘密らしいキー名 + window title を除外 + 2000字カット + キー数上限」の
**blacklist**。`operations.ts` の `sanitizeDetail` も完全一致 blacklist。→ `prompt`/`documentBody`/
`content`/`accessToken2` 等のキーなら本文・秘密が保存され、「操作メタデータ + 参照のみ」契約を破れる。

**提案**: source/action（および operation kind）ごとの**明示 serializer（allowlist）**へ変更。
- source 別に「保存を許すキー集合と型」を定義:
  - `mcp_access` → `{tool, kind, ok, durationMs, errorClass?}`
  - `ui_access` → `{route, method, kind, status, ok, durationMs}`
  - `workbench_change` → `{domain, action, resourceType?, path?, previousPath?, version}`
  - `pc_activity` → `{app, idle, intervalSeconds, windowTitle?(opt-in時のみ)}`
  - `agent_session` → `{event, ...明示キー}`
  - `local_file` → `{eventType, relativePath, mtime, size}`（A4 実装時）
- 許可キー以外は**破棄**（blacklist ではなく allowlist）。値型も検証（string 長制限は維持）。
- operation detail も operation kind ごとの allowlist に。
- ingest 側 gate（disabled source 拒否）は現状維持。

**効果**: 「メタデータ + resource 参照まで」の契約を構造的に保証。将来キー追加は明示追加のみ。

**工数**: M（serializer 定義 + observations/operations 修正 + テスト更新）。**P1。**

### A4. `local_file` 収集の実装 or UI からの撤去（P1）

**現状**: UI はファイル操作・path・root allow/deny の収集を提供するが、**local_file
observation を生成する producer が存在しない**。ingest filter も project/resourceType のみ
評価し、localRootAllow/deny・excludePatterns を無視。設定一式が実質無効。

**提案（二択）**:
- **(推奨) 実装**: sync-daemon に file watcher producer を追加。明示 root のみ監視、
  event type / relative path / mtime / size のみを local_file observation として ingest
  （本文は読まない・送らない）。ingest filter に localRootAllow/deny・excludePatterns 評価を追加。
  柱 A（データ活用）に沿う本命。**工数 L。**
- **(暫定) 撤去**: 実装を後回しにするなら、Settings UI から local_file 系トグルと
  root allow/deny を撤去し「未提供（planned）」と明記。設定と実挙動の乖離を即解消。**工数 S。**

判断: データ活用方針なら実装。短期の整合性優先なら撤去→後日実装。

### A5. Activity の timezone 対応（P2）

**現状**: UI はローカル日付（`localDateString`）を送るが、aggregate SQL は
`occurred_at::date` を DB timezone で切る。DB が UTC なら Asia/Tokyo と 9h ずれ、
daily summary・期間表示が誤る。

**提案**: API に IANA timezone を渡し、集計を `(occurred_at AT TIME ZONE $tz)::date` で行う。
observations の from/to 日付境界も同 timezone で解釈（A5 は eab656d の date 受付修正の続き）。
UI は既知の timezone（uiSettings.language / ブラウザ TZ or Analyser Settings の routine timezone）を送る。

**工数**: S〜M（aggregate クエリ + observations 日付境界 + API/UI 配線 + テスト）。**P2。**

### A6. machine 同定の健全性（P2）

**現状**: `analyser_observations.machine_id` に FK 無し、ingest も machine 存在を検証しない。
daemon は取得済み machine ID を永続キャッシュするため、DB 復元・再構築後も stale ID を送信。
→ machine override 不適用、UI の machine 一覧と observation が不一致。

**提案**:
- ingest 時に `machine_id` の所有権・存在を検証（owner scope で machines に存在するか）。
  未知なら reject または `machine_id=null` で受理（要方針決定）。
- daemon: ingest が machine 未知エラーを返したら**再登録して新 ID を採用**（register は
  machine_key で冪等なので、同一 key なら同一 machine に収束）。`analyser.machineId` meta を更新。
- （任意）observations.machine_id に緩い FK（ON DELETE SET NULL）を付与。
- UI: machine セレクタと observation の machine_id 対応を担保。

**工数**: M（analyser ingest + daemon uploader + 任意で schema）。**P2。**

---

## 3. 柱 B: skill の独自保持（P2・enhancement）

### B1. routine の skill snapshot / 参照健全性

**現状**: `analyser_routines.skill_key`（+`skill_version`）は識別子のみ。skill 本文は
AgentSkills 正本 artifacts にのみ存在。正本 skill 削除時、Analyser は無検知で `claim` を返し、
実行 agent が skill 不在で失敗する。Analyser 単体での復元・検知手段が無い。

**提案（段階実装）**:
1. **参照健全性チェック（軽量・先行）**: routine 保存時/一覧時に skillKey が正本に実在するか
   Core 経由で検証し、Overview/Routines タブに「skill missing」警告バッジを表示。**工数 S。**
2. **skill snapshot 独自保持（本命）**: 新表 `analyser_skill_snapshots`
   （owner, skill_key, skill_version, content_hash, body_markdown, source_ref, captured_at）を追加。
   routine は snapshot を参照。materialization routine 実行時や明示操作で snapshot を更新。
   - 正本削除・改変を content_hash 差分で検知し proposal 化。
   - 正本消失時も「最後に確認した skill」で実行継続 or 明示ブロックを選択可能に。
   - Analyser が skill の**独自コピーを保持**する Owner 要望を満たす。**工数 M。**
3. （任意）Routines タブに skill snapshot のプレビュー/版差分表示。

判断: まず (1) 警告バッジで可視化 → (2) snapshot 保持、の順が低リスク。

---

## 4. 横断課題: Export の堅牢化

### C1. dedupe に canonicalized destination を含める（P2）

**現状**: `contentHash = sha256(targetKind + "\n" + content)`。projectId/path 非包含のため、
同一 summary を別 Project/別 path へ export しても新規保存先を作らず旧 target を成功として返す。

**提案**: dedupe key/hash に **canonicalized destination（targetKind + projectId + 正規化 path）**
を含め、DB 一意制約も同じ組で張り直す。既存 `analyser_publications` の unique 制約
（owner, source_kind, source_id, target_kind, content_hash）に projectId/path を追加、
または content_hash の入力へ destination を混ぜる。migration は既存行の再ハッシュ要否を検討。

**工数**: M（hash 入力 + 一意制約 migration + テスト）。**P2。**

### C2. Export 予約のライフサイクル管理（P2）

**現状**: publication 予約→Note/Artifact 作成の順。作成/finalize 失敗時の予約解除・期限が
無く、空 targetId を 3 秒 poll して 503 を返し続ける残骸が残る。

**提案（二択）**:
- **(推奨) 順序反転 + 冪等化**: 先に target を作成 → publication を記録。並行重複作成は
  C1 の一意制約 + 作成前の findPublication 再確認で抑制（競合時は後勝ちを検知して片方を
  参照）。空予約が原理的に発生しない。
- **(代替) 予約状態管理**: publication に status(pending/committed) + holder + expiry を持たせ、
  期限切れ pending を掃除、失敗時に安全解除。

**工数**: M。**P2。**

---

## 5. ロードマップ（提案）

優先度は「柱 A（データ活用）> privacy 契約 > 横断 > 柱 B」を基本に、Owner 意向を反映。

| フェーズ | 内容 | 分類 | 目安 |
|---|---|---|---|
| **P1-a** | A1 resource-ref extractor（アクセス観測を使えるように） | correctness | M |
| **P1-b** | A3 metadata/detail allowlist 化（契約保証） | privacy | M |
| **P1-c** | A2 daemon への収集ポリシー反映（UI 設定を実効化） | privacy | M〜L |
| **P1-d** | A4 local_file: 実装 or UI 撤去（方針決定） | correctness | S/L |
| **P2-a** | A5 timezone 集計 / A6 machine 同定 | correctness | S〜M |
| **P2-b** | C1 export dedupe / C2 予約ライフサイクル | robustness | M |
| **P3** | B1-(1) skill 参照健全性バッジ → B1-(2) skill snapshot 保持 | enhancement | S→M |

推奨着手順: **P1-a → P1-b → P1-c**（柱 A のデータが使え、契約が守られ、設定が効く状態を
先に作る）→ P1-d 方針決定 → P2 群 → P3（柱 B）。各フェーズは独立 commit・テスト付き。

## 6. 実装しない場合の最小整合策（参考）

フル実装を見送る項目は、**UI から「見えるのに効かない設定」を撤去**して乖離だけ先に解消する:
- A2: Settings の foreground/windowTitle/screenshot トグル撤去（「daemon 設定で管理」明記）
- A4: local_file 系トグル・root allow/deny 撤去（「planned」明記）

ただし Owner の「収集データ活用」方針とは逆行するため、本命は各フェーズの実装。

---

## 6.5 承認済みスコープ（2026-07-21）と実装計画

Owner 承認により **A2 / A4（local_file 実装）/ 派生テキスト集約** を実装する。
派生データのサーバ集約は **「派生テキストのみ」**（Owner 選択）:
スクショ/キャプチャ画像は**ローカル限定を維持**し、ローカル agent が生成した
**テキスト要点だけ**を明示 opt-in でサーバへ集約する（旧 `insights.derived.ingest`
の analyser 版を復活）。OCR 全文・画像・secret は集約しない。

### 実装 wave

| Wave | 内容 | 対象 | 状態 |
|---|---|---|---|
| IW-1 | A2: daemon に共有 ServerPolicyProvider を導入し、foreground/windowTitle/screenshot を「ローカル設定 AND サーバー effective policy」で取得段階 gate（stricter-wins） | sync-daemon | `[implemented]` (137861b) |
| IW-2 | A4: local_file watcher producer（明示 root のみ・metadata のみ）+ analyser ingest filter に localRoot allow/deny・excludePatterns 評価を追加 + local_file の metadata allowlist | sync-daemon, analyser | `[implemented]` (cfed072) |
| IW-3 | 派生テキスト集約: analyser に derived-capture store + ingest route + MCP tool（agent-facing）、collection 設定に `screenshotDerivedUpload`(既定 false・明示 opt-in) 追加、UI に表示/設定 | analyser, core, ui | `[implemented]` (582bda3 IW-3a + c0ac625 IW-3b) |

### 設計メモ

- **ServerPolicyProvider（IW-1）**: uploader の既存 60s cache 付き
  `/api/analyser/settings/effective` 取得を共有プロバイダへ切り出し、uploader と
  CaptureManager が同一キャッシュを参照。CaptureManager は `effectiveConfig()`
  = ローカル config を server policy で絞った値を supervisor/scheduler へ渡し、
  policy 変化時に start/stop を再構成。**取得失敗時は last-known を保持**、一度も
  取得できていない起動直後は**ローカル opt-in を暫定 gate**（local で明示 ON した
  もののみ）とし、初回取得後にサーバー設定を強制。screenshot は
  `local.screenshotsEnabled && server.screenshots !== "off"`、foreground は
  `local.enabled && server.foregroundAppCapture !== "off"`、windowTitle は
  両者 AND。
- **local_file（IW-2）**: 監視対象 root は server collection settings の
  `localRootAllow` を daemon が effective 取得して使用。event type / relative path /
  mtime / size のみを local_file observation として ingest（本文非読取）。
  `localRootDeny`・`excludePatterns` を daemon 側と analyser ingest 側の二重 gate。
  ローカルは既定 OFF、`server.localFileEvents !== "off" && server.localFileUpload`
  も必要。
- **派生テキスト（IW-3）**: 新 setting `screenshotDerivedUpload`(bool, 既定 false)。
  ローカル agent が capture 機上でスクショを処理し、要点テキストを
  `analyser.captures.derived.ingest`（新 MCP tool、machine-scoped）で明示送信。
  analyser に軽量な `analyser_derived_captures` 相当の store（machine_id, kind,
  title, summary_markdown(要点・size 制限), evidence_refs, occurred_at）。画像・
  OCR 全文・secret は保存しない。解析ルーチンが参照可能に。UI に一覧表示。

## 6.6 二重最終レビュー結果（2026-07-21）

IW-1..3 完了後、Claude + Codex(read-only) の二重最終レビューを実施。Codex が 7 major +
4 minor を検出、Claude が committed コードで全件妥当性判定し、**実欠陥 10 件を修正**
（commit 82a2aa8、F1..F10b）。daemon 130 / analyser 89 テスト通過。修正の要点は commit
メッセージ参照。

**許容制約（今回は修正せず記録）:**
- **F10a**: `fs.watch` は created と modified を区別できないため、既存ファイルは常に
  `modified` として emit（`created` は type に残すが未使用）。OS の制約。
- **F11 / A5**: Activity タブの日付範囲が UTC 基準でローカル日付とずれる問題は
  derived-capture セクションにも共通。**A5（別 P2 wave）**として timezone 対応時に
  Activity タブ全体で一括修正する。
- **F4 の残**: derived summaryMarkdown の OCR 全文・秘密テキストは、agent 生成の
  分析コンテンツとして summaries と同様 convention に委ねる（画像 base64 のみ構造的に
  reject）。
- **F5 の残 / A6**: derived ingest は machineId 提供時に requireMachine で検証するが、
  observation 全体の machine FK / stale ID 対策は **A6（別 P2 wave）**。

## 6.7 追加改善 wave（2026-07-22）実装結果

Owner 指示「残りの提案項目を順次・分割 commit で実装、最後にまとめレビュー」に基づき、
柱 A データ活用〜横断〜柱 B stage 1 を実装。各 commit は codex 実装 + Claude レビュー。

| 項目 | 内容 | 対象 | 状態 |
|---|---|---|---|
| A1 | アクセス観測に resource-ref extractor（MCP tool / HTTP route → note/artifact/project/task 等の id・path のみ抽出） | core | `[implemented]` (ebaf016) |
| A3 | metadata を per-source allowlist・operation detail を per-kind allowlist に変更（本文混入を構造的に遮断、unknown source/kind は fail-closed） | analyser | `[implemented]` (b5eb519) |
| A5 | Activity 集計を viewer の IANA timezone で `AT TIME ZONE` バケット化、UI は observations/derived へ UTC instant を送信（UTC 既定で後方互換） | analyser, ui | `[implemented]` (b7e15a2) |
| A6 | ingest で machine 所有権検証。未知 context machine は 409 `MACHINE_UNKNOWN` で reject、未知 per-observation machine は null 強制。daemon は 409 で再登録（machine_key 冪等）→ 1 回リトライで自己修復。FK は範囲外 | analyser, sync-daemon | `[implemented]` (5c29035) |
| C1 | export dedupe hash に canonicalized destination（targetKind + projectId + 正規化 path）を混入。別 Project/別 path への再 export が新規 target を作成。migration 不要（既存 unique 制約を hash 経由で destination-aware 化） | core | `[implemented]` (a47837c) |
| B1-(1) | skill 参照健全性: `GET /api/analyser/skills/catalog`（AgentSkills artifacts tree から skill key 集合、artifacts 障害時は 200 + `unavailable`）+ Routines タブに advisory「skill missing」バッジ | core, ui | `[implemented]` (b98416e) |
| B1-(2a) | skill snapshot 独自保持: 新表 `analyser_skill_snapshots`(owner, skill_key unique) + **明示 upsert**（`analyser.skills.snapshot.upsert` MCP tool / `POST /skills/snapshots`、自動捕捉なし）+ 共有 `normalizeSkillBody`/`hashSkillBody` + routine `skill_missing` ブロックフラグ + `setRoutineSkillMissingByKeys` + claim gate（`skill_missing=TRUE` は claim されず due のまま留まる） | analyser, core | `[implemented]` (5c159af) |
| B1-(2b) | skill 整合性判定: `runSkillIntegrityCheck`（正本 `skills/<key>/SKILL.md` を content 付きで読み snapshot と hash 比較）→ **missing は fail-safe でフラグ reconcile**、**drift は dedupe 付き `skill_drift` proposal 自動生成（非ブロック）**。`POST /api/analyser/skills/integrity/run` + `analyser.skills.integrity.run` MCP tool + 専用 seed routine `skill-integrity-check`(0 4 * * *) + Routines タブ手動ボタン + 「blocked · skill missing」バッジ | core, analyser, ui | `[implemented]` (4e0e31c) |

**B1-(2) の Owner 決定（2026-07-22 反映）**: (1) fail-safe = **消失のみブロック**（drift は proposal 化のみ・非ブロック）、(2) 整合性判定は**専用 routine `skill-integrity-check`**、(3) drift は**自動 proposal 化**。snapshot 更新は**明示操作**（自動捕捉なし）。fail-safe なので snapshot 本文は復元・監査用に保持し、実行継続には使わない（＝正本消失時は継続せずブロック）。

**設計メモ / 既知の制約**:
- 整合性ロジックの `normalizeSkillBody`/`hashSkillBody` は core と analyser に**意図的に二重定義**（サービス跨ぎで import 不可）。パリティテストで一致を保証。
- `skill-integrity-check` routine の skill_key は `workbench-analyser-cycle`。実行主体はエージェント claim（既存 routine と同様）で `analyser.skills.integrity.run` を呼ぶ。UI 手動ボタンでも即時実行可。サーバー完全自律の定期実行が必要なら Core scheduler 化が follow-up 候補。

## 7. 次アクション

Owner 承認後、フェーズ単位で着手する。着手順・粒度（例: まず P1-a のみ / P1 一括 / 柱 B
先行 など）の指定を受けて実装計画へ展開する。各項目は既存の analyser/core/daemon/ui の
テスト構成に沿って単体 + route + （必要なら）live smoke で検証する。
