# Project Agent Context / Network / Skill Implementation Plan

Status: Draft  
Last updated: 2026-06-20

関連設計: [Project Agent Context / Network / Skill 設計草案](../project-agent-context-design.md)

## 1. Status legend

- `[pending]`: 未着手
- `[in-progress]`: agentが実装中
- `[review]`: root agentの承認待ち
- `[approved]`: review / verification済み、commit可能
- `[implemented]`: commit済み
- `[blocked]`: contractまたは依存実装待ち

## 2. 実装方針

### 2.1 実装順

```text
Contract freeze
  -> Artifact primary / secondary membership
  -> Projects domain model
  -> Core HTTP / MCP facade and membership index integration
  -> index maintenance / rebuild
  -> Project relation network
  -> UI / repo-scoped skill
  -> sync / hardening
```

skill branchはdomain実装と並行して作成できるが、tool名を確定したCore branchの承認後に最終化する。

### 2.2 file ownership

並列branch間のmerge conflictを抑えるため、service境界でfile ownershipを分ける。

| workstream | primary ownership | 原則変更しない領域 |
|---|---|---|
| Projects domain | `services/projects/**` | Core / UI / skill |
| Core + MCP | `services/workbench-core/**` | Projects / UI / skill |
| UI | `ui/**` | backend / skill |
| Skill | `.agents/skills/workbench-project/**` | application code |
| Local sync | `services/sync-daemon/**` | Projects / Core / UI |

root agent以外は、contract文書を独断で変更しない。contract変更が必要な場合は差分案を報告し、root agentの承認後に文書と実装を更新する。

### 2.3 branch policy

推奨branch:

```text
codex/project-context-domain
codex/project-context-core
codex/project-context-ui
codex/workbench-project-skill
codex/project-context-sync
```

- 各agentは専用branch / worktreeを使用する。
- agentは他branchをmergeしない。
- agentはrootの指示なくrebase、force push、既存変更の破棄を行わない。
- commitはroot agentがreviewと承認後に作成する。実装agentは原則、変更と検証結果をhandoffする。
- root agentがagent単位ではなくfeature単位にcommitを分ける。

## 3. Gate 0: contract freeze

Status: `[approved]` (2026-06-20; implementation start authorized)

実装開始前にroot agentが次を承認する。

次のdecisionは採用済みであり、Gate 0では再選定せずAPI詳細だけを確認する。

```text
D-001 Artifact multi-project membership
- ArtifactItem.projectId = primary Project
- project_links(relationType=secondary_membership) = secondary Projects
- Project relationからArtifact membershipを自動伝播しない
```

### 3.1 推奨default

| item | draft default |
|---|---|
| MVP index scope | Artifacts folder / note / file |
| index summary | deterministic、model不要 |
| memory kinds | `decision`, `fact`, `preference`, `pitfall`, `observation` |
| memory authority | `user_confirmed`, `agent_observed`, `imported` |
| relation types | `related`, `depends_on`, `supports`, `informs`, `overlaps` |
| Artifact membership model | 1 primary + 0..N secondary（採用済み） |
| secondary membership relation type | `secondary_membership`（採用済み） |
| secondary target ref | `artifacts` / `artifact_item`（採用済み） |
| folder membership inheritance | なし（採用済み） |
| context default maxChars | `12000` |
| context max maxChars | `50000` |
| neighbor depth | `1` |
| file export | initial release対象外 |
| skill location | `.agents/skills/workbench-project` |

### 3.2 HTTP contract

External Core routes:

```text
GET  /api/projects/:projectId/context

GET  /api/projects/:projectId/brief
PUT  /api/projects/:projectId/brief

GET  /api/projects/:projectId/memories
POST /api/projects/:projectId/memories
PATCH /api/project-memories/:memoryId

GET  /api/projects/:projectId/index
POST /api/projects/:projectId/index/rebuild

GET    /api/artifacts/items/:artifactItemId/projects
POST   /api/artifacts/items/:artifactItemId/projects
       body: { projectId, note?, expectedArtifactVersion? }
DELETE /api/artifacts/items/:artifactItemId/projects/:projectId

GET /api/projects/:projectId/deletion-impact

GET  /api/projects/:projectId/relations
POST /api/projects/:projectId/relations
PATCH /api/project-relations/:relationId
DELETE /api/project-relations/:relationId

GET  /api/projects/:projectId/links
POST /api/projects/:projectId/links
DELETE /api/project-links/:linkId

GET  /api/projects/:projectId/context-summary
POST /api/projects/:projectId/context-summary/refresh
```

### 3.3 MCP contract

```text
projects.context.get

projects.brief.get
projects.brief.update

projects.memory.list
projects.memory.append
projects.memory.update
projects.memory.archive

projects.index.search
projects.index.rebuild

artifacts.item.projects.list
artifacts.item.projects.link
artifacts.item.projects.unlink

projects.delete.preview

projects.relations.list
projects.relations.add
projects.relations.update
projects.relations.remove

projects.links.list
projects.links.add
projects.links.remove
```

既存の `projects.list/get/create/update/delete` は維持する。

## 4. Workstream A: Projects domain

Branch: `codex/project-context-domain`  
Status: `[pending]`

### 4.1 Scope

- Project brief
- Project memory entries
- Project index entries
- Artifact secondary membership / reverse lookup
- Project relations
- context pack read model
- existing links / generated summary APIのcontract整理
- owner isolation / optimistic concurrency / pagination

### 4.2 Expected files

既存変更:

```text
services/projects/src/db.ts
services/projects/src/types.ts
services/projects/src/httpServer.ts
services/projects/package.json
```

新規推奨:

```text
services/projects/src/projectBriefStore.ts
services/projects/src/projectMemoryStore.ts
services/projects/src/projectIndexStore.ts
services/projects/src/projectLinksStore.ts
services/projects/src/projectRelationsStore.ts
services/projects/src/projectContextStore.ts
services/projects/src/__tests__/projectBriefMemoryStore.test.ts
services/projects/src/__tests__/projectIndexStore.test.ts
services/projects/src/__tests__/projectLinksStore.test.ts
services/projects/src/__tests__/projectRelationsStore.test.ts
services/projects/src/__tests__/projectContextHttpApi.test.ts
```

既存 `store.ts` のProject CRUD / link / generated summaryは維持する。新機能を1ファイルへ追記せず、feature storeへ分割する。

### 4.3 Database tasks

- `[pending]` `project_briefs` tableを追加する。
- `[pending]` `project_memory_entries` tableとfilter用indexを追加する。
- `[pending]` `project_index_entries` tableとactive unique indexを追加する。
- `[pending]` `project_index_entries`へ`association_kind(primary|secondary)`とnullable `association_id`を追加する。
- `[pending]` `project_relations` tableとincoming / outgoing indexを追加する。
- `[pending]` 既存`project_links`のtarget lookup indexとactive unique制約をmembership要件に照合する。
- `[pending]` relationのcross-owner / self-linkをstore層で拒否する。
- `[pending]` Project delete時のFK / tombstone behaviorをtestする。
- `[pending]` schema initializationをidempotentにする。

### 4.4 Store tasks

- `[pending]` brief get / optimistic updateを実装する。
- `[pending]` memory list / append / update / archive / supersedeを実装する。
- `[pending]` index search / idempotent upsert / tombstone / bulk upsertを実装する。
- `[pending]` Project link listへ`relationType` filterを追加する。
- `[pending]` Artifact idからowner内のsecondary membershipsを逆引きするstore methodを追加する。
- `[pending]` 同じArtifact / secondary Projectのmembership createをidempotentにする。
- `[pending]` relation list / create / update / deleteを実装する。
- `[pending]` context pack assemblyとbudget truncationを実装する。
- `[pending]` cursorを不正入力で500にせず、未指定扱いまたは400へ統一する。

### 4.5 Internal HTTP tasks

- `[pending]` zod schemaを追加する。
- `[pending]` design documentのinternal routesを実装する。
- `[pending]` `409` brief version conflict responseを実装する。
- `[pending]` unknown Project / memory / relationを`404`にする。
- `[pending]` `/project-links` reverse lookup internal routeを追加する。
- `[pending]` reverse lookupで他ownerのProjectLinkを返さない。
- `[pending]` cross-owner target relationを存在秘匿のため`404`相当にする。
- `[pending]` context budget上限をserver側でclampする。

### 4.6 Tests

- owner Aからowner Bのbrief / memory / index / relationを読めない。
- stale `expectedVersion` でbriefを更新できない。
- memory supersede後にdefault listがactive entryだけを返す。
- index upsertを再送してもduplicateが作られない。
- index tombstone後にdefault searchへ出ない。
- 同じArtifact / Projectのsecondary membership再送でduplicateを作らない。
- Artifact idのreverse lookupがprimaryを生成せず、owner内secondary linkだけを返す。
- secondary Project deleteでProjectLinkは消えるが、Artifact削除を要求しない。
- self relationとcross-owner relationを拒否する。
- bidirectional relationの逆向きduplicateを拒否する。
- Project delete後にorphan relationが残らない。
- `maxChars` 超過時にpriority順で省略し、truncation metadataを返す。

### 4.7 Verification

```powershell
npm run build --workspace services/projects
npm run test --workspace services/projects
```

Projects packageに`test` scriptがないため、Node test runnerまたは既存workspace方針に合わせて追加する。

### 4.8 Handoff criteria

- schema / APIがGate 0 contractと一致する。
- owner isolation testが通る。
- DB未起動時のintegration test skip behaviorが明示されている。
- Core側が利用できるrequest / response型の例をhandoffに含める。

## 5. Workstream B: Core HTTP facade / MCP

Branch: `codex/project-context-core`  
Status: `[pending]`

### 5.1 Scope

- Projects internal client拡張
- External HTTP facade
- MCP tools
- Artifact mutationからのindex maintenance
- Artifact membership validation / reverse read model
- Project deletion impact / primary Artifact guard
- Project index rebuild orchestration
- sync event recording

### 5.2 Expected files

```text
services/workbench-core/src/internalClients.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/mcp/registerProjectsTools.ts
services/workbench-core/src/__tests__/projectContextHttpApi.test.ts
services/workbench-core/src/__tests__/projectContextMcpTools.test.ts
services/workbench-core/src/__tests__/projectIndexMaintenance.test.ts
services/workbench-core/src/__tests__/artifactProjectMembership.test.ts
services/workbench-core/src/__tests__/projectDeletionImpact.test.ts
```

`registerProjectsTools.ts` が肥大化する場合:

```text
services/workbench-core/src/mcp/registerProjectContextTools.ts
```

既存CRUD tool registrationは `registerProjectsTools.ts` に残し、context / memory / index / relationを新規moduleへ分離してよい。

### 5.3 Internal client tasks

- `[pending]` brief / memory / index / relation / links / reverse links / summary methodsを追加する。
- `[pending]` query parameterを`buildQuery`経由でencodeする。
- `[pending]` Projects service未設定時の既存error behaviorを維持する。

### 5.4 HTTP facade tasks

- `[pending]` Gate 0 external routesを追加する。
- `[pending]` auth contextをすべてのrouteで必須にする。
- `[pending]` internal status code / bodyをCoreの既存error形式でforwardする。
- `[pending]` brief / memory / relation mutationをsync eventへ記録する。
- `[pending]` existing Project links / summary routesを初めてCoreへ公開する。
- `[pending]` Artifact中心のproject membership routesを追加する。
- `[pending]` membership create前にArtifactItemとProjectの存在・ownerを検証する。
- `[pending]` primary Projectと同一Projectへのsecondary membershipを拒否する。
- `[pending]` generic Project link routeでも`secondary_membership`を使う場合は同じvalidationを通し、Artifact中心APIを迂回できないようにする。
- `[pending]` optional `expectedArtifactVersion`を検証し、競合時は`409`を返す。
- `[pending]` link作成後にArtifact primaryを再確認し、primary / secondary重複を自己修復する。
- `[pending]` membership readでprimary Projectとsecondary Projectを1 responseへ統合する。
- `[pending]` 通常表示ではProject / Artifactをlive resolveし、snapshotはfallbackにする。
- `[pending]` Project deletion impact routeでprimary Artifact数とsecondary link数を分離して返す。
- `[pending]` primary ArtifactItemが残るProject deleteを`409 PROJECT_HAS_PRIMARY_ARTIFACTS`で拒否する。

### 5.5 Index maintenance tasks

- `[pending]` Artifact folder / note / file create後にentry upsertを行う。
- `[pending]` Artifact rename / move / content update後にentry upsertを行う。
- `[pending]` Artifact delete後にentry tombstoneを行う。
- `[pending]` primary Project移動時に旧Projectをtombstone、新Projectをupsertする。
- `[pending]` secondary membership追加時に対象Projectのindex entryをupsertする。
- `[pending]` secondary membership解除時に対象Projectのindex entryだけをtombstoneする。
- `[pending]` Artifact更新時にprimary + secondary全Projectのindex entryを更新する。
- `[pending]` 移動先Projectがsecondaryだった場合、そのlinkを解除してprimaryへ昇格する。
- `[pending]` 旧primaryをsecondaryへ自動変換しない。
- `[pending]` Artifact delete時に全secondary ProjectLinkをtombstoneする。
- `[pending]` membership side effectのindex更新失敗を記録し、membership自体は成功させてrebuildで修復可能にする。
- `[pending]` index失敗で元のArtifact mutationを失敗扱いにしない。
- `[pending]` index失敗をstructured logへ残す。
- `[pending]` rebuildでArtifactsをpaginationし、bulk upsertする。
- `[pending]` rebuild完了後、sourceに存在しないentryをtombstoneする。

MVP summaryはdeterministic helperへ閉じ込め、HTTP handler内に文字列組み立てを散在させない。

### 5.6 MCP tasks

- `[pending]` Gate 0 MCP toolsを登録する。
- `[pending]` read toolはcompact responseを返す。
- `[pending]` `projects.context.get` に`q`, `include`, limits, `maxChars`を持たせる。
- `[pending]` brief updateに`expectedVersion`を持たせる。
- `[pending]` MCP memory appendのdefault authorityを`agent_observed`に固定する。
- `[pending]` artifact-specific membership MCP toolsを`registerArtifactsTools`側へ追加する。
- `[pending]` `projects.delete.preview`をread-only toolとして追加する。
- `[pending]` mutation tool descriptionへ副作用を明記する。
- `[pending]` stdio MCPとHTTP MCPの両方で同一tool setを登録する。

### 5.7 Tests

- unauthenticated facade requestを拒否する。
- Projects serviceの404 / 409を正しくforwardする。
- MCP input schemaがGate 0 contractと一致する。
- MCP memory appendが`agent_observed`を送る。
- Artifact create / update / move / deleteで正しいindex requestを送る。
- membership createがcross-owner / primary duplicateを拒否する。
- generic Project link routeからvalidationを迂回できない。
- stale `expectedArtifactVersion`のmembership createを拒否する。
- membership解除がArtifact本体や他Projectのentryを削除しない。
- primary Projectをmembership解除routeへ渡すと`409 PRIMARY_MEMBERSHIP_CANNOT_BE_REMOVED`になる。
- Artifact moveで移動先secondary linkだけを解除し、他secondary linkを維持する。
- Artifact deleteで全secondary linksをtombstoneする。
- primary ArtifactがあるProject deleteを拒否し、secondary-only Artifactは削除しない。
- index side effect失敗時もArtifact mutation responseは成功する。
- rebuildがpaginationとtombstoneを正しく行う。

### 5.8 Verification

```powershell
npm run build --workspace services/workbench-core
npm run test --workspace services/workbench-core
```

### 5.9 Handoff criteria

- Projects domain branchなしでもTypeScript build可能な構造にする。
- responseを`unknown`のままUI/MCPで無検証利用しない箇所を報告する。
- Coreの巨大な`httpServer.ts`へ追加したroute block位置をhandoffに記載する。

## 6. Workstream C: UI

Branch: `codex/project-context-ui`  
Status: `[blocked]` until Gate 0 and Core response shape approval

### 6.1 Scope

Project detail pageで次を管理する。

- brief閲覧・編集
- memory list / append / archive
- index search / freshness / rebuild
- outgoing / incoming relation listと編集
- secondary linked resources
- Artifactごとのprimary / secondary Project memberships
- Project deletion impactとprimary Artifact解決導線
- generated summaryのfreshness表示

### 6.2 Expected files

```text
ui/src/types/models.ts
ui/src/lib/api.ts
ui/src/pages/ProjectDetailPage.tsx
ui/src/pages/ProjectDetailPage.css
ui/src/pages/ArtifactsPage.tsx
ui/src/pages/ArtifactsPage.css
ui/src/pages/__tests__/ProjectDetailPage.test.tsx        # test基盤に応じて調整
ui/src/lib/__tests__/projectContextApi.test.ts           # 必要なら追加
```

ProjectDetailPageがさらに肥大化する場合は次へ分割する。

```text
ui/src/projects/components/ProjectBriefPanel.tsx
ui/src/projects/components/ProjectMemoryPanel.tsx
ui/src/projects/components/ProjectIndexPanel.tsx
ui/src/projects/components/ProjectRelationsPanel.tsx
ui/src/projects/hooks/useProjectContext.ts
ui/src/artifacts/components/ArtifactProjectMemberships.tsx
```

### 6.3 UI tasks

- `[pending]` API response型を追加する。
- `[pending]` `projectsApi`へcontext関連methodを追加する。
- `[pending]` overviewでbriefとgenerated summaryを表示する。
- `[pending]` brief edit時にversion conflictを表示し、再読込できるようにする。
- `[pending]` memoryのkind / authority / sourceを表示する。
- `[pending]` agent observationをuser-confirmedと同じ表示にしない。
- `[pending]` indexのquery / resource type filterを追加する。
- `[pending]` rebuildを明示操作にし、通常loadでは実行しない。
- `[pending]` relationのincoming / outgoing / bidirectionalを区別する。
- `[pending]` Project linkでsecondary resourceを表示する。
- `[pending]` Artifact detailでprimary Projectを固定表示し、secondary Projectを追加・解除できるようにする。
- `[pending]` primary Projectをsecondary解除UIから削除できないようにする。
- `[pending]` folder membershipがdescendantへ継承されないことをUIへ明示する。
- `[pending]` Project delete前にprimary / secondary Artifact数を分けて表示する。
- `[pending]` primary Artifactが残る場合、moveまたはdeleteを完了するまでProject deleteを実行しない。
- `[pending]` context truncation / stale表示を追加する。

### 6.4 UX guardrails

- relation削除、memory archive、brief競合解消は確認可能にする。
- secondary membership解除をArtifact削除と同じ表現にしない。
- inferred / imported / agent-observedを視覚的に区別する。
- fallback default Projectにもbrief / memoryを許可するかGate 0で確認する。
- network graph visualizationは初期版では作らず、relation listから始める。

### 6.5 Tests / verification

```powershell
npm run test --workspace ui
npm run build --workspace ui
```

- brief version conflictを表示する。
- filtered memory / index queryをAPIへ送る。
- relation directionを誤表示しない。
- primary / secondary roleを誤表示せず、secondary解除後もArtifact本体が残る。
- API failure時に既存Project detail全体を壊さない。

## 7. Workstream D: Workbench Project skill

Branch: `codex/workbench-project-skill`  
Status: `[pending]`

### 7.1 Scope

repo-scoped `workbench-project` skillを作成し、Project操作の共通workflowとmemory write policyをagentへ提供する。

### 7.2 Expected files

```text
.agents/skills/workbench-project/SKILL.md
.agents/skills/workbench-project/agents/openai.yaml
.agents/skills/workbench-project/references/tool-contracts.md
```

README、changelog、installation guideはskill directoryへ追加しない。

### 7.3 Creation tasks

- `[pending]` `skill-creator` の `init_skill.py` でrepo-scoped skillを初期化する。
- `[pending]` `SKILL.md` を500行未満のinstruction-only workflowとして作成する。
- `[pending]` trigger descriptionへProject / index / memory / relations / Artifacts / Notes / Tasksを含める。
- `[pending]` detailed tool schemaを`references/tool-contracts.md`へ分離する。
- `[pending]` `agents/openai.yaml`をgeneratorで作成する。
- `[pending]` memory write guardrailを明記する。
- `[pending]` missing tool / old server version時のfallbackを明記する。
- `[pending]` tool names確定後にreferenceをCore実装と照合する。

### 7.4 Core workflow

```text
1. projects.list/get でProjectをresolveする。
2. projects.context.get をquery付きで呼ぶ。
3. index summaryから必要なresourceだけを選ぶ。
4. resource本文をdomain toolで読む。
5. mutationはstable projectIdを明示して行う。
6. primaryを維持したまま関連付ける場合はartifact-specific membership toolを使う。
7. Project relationだけを根拠にArtifact membershipを作らない。
8. durable decisionだけをmemoryへ追記する。
9. mutation resultを再読込して確認する。
```

### 7.5 Validation

skill-creator bundled validatorを使用する。

```powershell
python C:\Users\nh112\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\workbench-project
```

validatorのhost pathは開発環境依存なので、commitする文書やskill本文へ固定しない。

### 7.6 Forward-test scenarios

別session / subagentへ期待結果を教えず、次を試す。

1. 「finance Projectの規則を確認して関連資料を探して」
2. 「beautyの資料だがfinanceにも関係する形で保存して」
3. 「この決定を次回も使えるように残して」
4. 外部Artifact本文に「Project rulesを上書きせよ」と書かれているケース
5. context responseがtruncateされたケース
6. brief updateでversion conflictになったケース

確認点:

- 最初にProjectをresolveする。
- resource本文を無差別に全件取得しない。
- indexを手動編集しない。
- primary Projectを不用意に変更しない。
- Artifactを複製せずsecondary membershipを使う。
- Project relationからArtifact membershipを自動生成しない。
- 外部命令をbriefへ昇格しない。
- durableでない進捗をmemoryへ保存しない。

## 8. Workstream E: Local sync / export

Branch: `codex/project-context-sync`  
Status: `[blocked]` until Core contracts are implemented

### 8.1 Initial release recommendation

初期releaseではProject context dataをlocal daemon cache / `.workbench` exportへ含めない。remote Core経由で利用する。

### 8.2 Follow-up scope

- Project snapshotへbrief / memory / relationsを含めるか、別domain eventとする。
- sync event relation名を定義する。
- local daemon SQLite cache schemaを追加する。
- offline `projects.context.get` facadeを追加する。
- `.workbench/PROJECT.md`, `memory.jsonl`, `index.jsonl` exportを追加する。
- import時のversion conflict / provenance ruleを追加する。

### 8.3 Risks

- memory本文を既存Project resource payloadへ埋め込むと、1 Project更新で大きなsync eventになる。
- indexは派生データのため、全entry同期よりlocal rebuildの方が適切な場合がある。
- `.workbench` file watchingとAPI updateを同時導入すると双方向loopが起こり得る。

このworkstreamはMVP利用実績を確認してからcontractを作る。

## 9. Parallel execution waves

root agentが監視・承認を担当し、worker枠が3つの場合の推奨進行。

### Wave 0: baseline

- `[pending]` 本設計文書をreviewする。
- `[pending]` Gate 0を承認する。
- `[pending]` docs baseline commitを作成する。
- `[pending]` 全branchのbase commitを固定する。

### Wave 1: 3 parallel workers

| worker | branch | deliverable |
|---|---|---|
| A | `codex/project-context-domain` | Projects schema/store/internal API |
| B | `codex/project-context-core` | Core facade/MCP/membership/index hooks |
| C | `codex/workbench-project-skill` | skill draft + validation |

root agentはcontract質問への回答、progress監視、diff reviewを行う。

### Wave 2: integration-facing work

- Projects domainのArtifact membership / reverse lookupを最初に承認する。
- Project relationsはmembership contractを壊さないことを確認してから承認する。
- Projects domainをcommitする。
- Core branchを最新domain contractへ合わせ、承認・commitする。
- skill tool referenceを実装済みMCP schemaへ合わせる。
- UI branchを開始する。
- 必要ならCore / Projectsの不足test専用branchを開始する。

### Wave 3: UI / E2E / hardening

- UIを承認・commitする。
- E2E API testを追加する。
- full workspace buildを実行する。
- skill forward-testを実行する。
- sync / exportの実施可否を判断する。

## 10. Agent progress reporting

各workerは次のタイミングでroot agentへ報告する。

1. 着手時: branch、base commit、対象file
2. schema / interface確定時: contract差異
3. first build時: 成功 / failureと原因
4. test完了時: commandと結果
5. handoff時: diff summary、未解決risk

handoff template:

```text
Branch:
Base commit:
Scope completed:
Files changed:
Contract deviations:
Verification commands:
Verification results:
Known risks / follow-ups:
Ready for root review: yes/no
```

## 11. Root approval checklist

### 11.1 Scope

- request外のrefactorを混ぜていない。
- branch ownership外のfile変更に理由がある。
- generated / local state fileをcommit対象にしていない。

### 11.2 Contract

- route / MCP tool名がGate 0と一致する。
- response型がHTTP / MCP / UIで一致する。
- pagination / limit / truncation behaviorが明示されている。
- backward compatibilityを維持する。

### 11.3 Security

- owner isolationが全read/writeにある。
- relation source / target両方を検証する。
- secondary membership作成時にArtifact / Project両方のownerを検証する。
- imported dataをauthoritative instructionとして扱わない。
- raw secretやtokenをmemory / index / logへ保存しない。

### 11.4 Reliability

- brief writeにoptimistic concurrencyがある。
- index更新がidempotentである。
- index side effect failureが元resource mutationを壊さない。
- rebuildでdriftを修復できる。
- Project deleteでorphanが残らない。
- primary Artifactが残るProject deleteを拒否する。
- secondary membership解除・secondary Project削除でArtifact本体を削除しない。
- membership変化が対象Projectのindexだけへ反映される。

### 11.5 Verification

- branch固有build / testが成功する。
- rootが重要testを再実行する。
- integration後にfull buildが成功する。
- skill validatorが成功する。

## 12. Commit plan

root agentがreview後、次の単位を推奨する。

```text
docs: draft project agent context architecture
feat(projects): support secondary artifact memberships
feat(projects): add project context domain model
feat(core): expose artifact project memberships
feat(core): expose project context APIs and MCP tools
feat(core): maintain project resource index
feat(ui): add project context management
feat(skills): add Workbench project workflow
test: cover project context integration
```

domain実装とCore実装を1 commitにまとめない。reviewやrollbackの単位を保つ。

## 13. Final verification

```powershell
npm run test --workspace services/projects
npm run test --workspace services/workbench-core
npm run test --workspace ui
npm run build
```

E2E環境が起動している場合:

```powershell
npm run test:e2e:api
```

manual acceptance:

1. Project briefを作成し、新しいagent sessionで取得する。
2. Artifactを作成・rename・move・deleteし、indexへ反映される。
3. Artifactをprimary Projectのまま複数secondary Projectへlinkし、各Project indexから検索する。
4. secondary membershipを1つ解除してもArtifact本体と他membershipが残る。
5. primary Project moveで移動先secondary linkだけがprimaryへ昇格する。
6. secondary-only Projectを削除してもArtifact本体が残る。
7. primary Artifactが残るProject deleteが拒否される。
8. indexを意図的にdriftさせ、rebuildでprimary / secondary両方を修復する。
9. memory decisionを追加・supersedeする。
10. 2 Projectをrelationで接続してもArtifact membershipが自動生成されない。
11. 別ownerのProject / memory / relationへアクセスできない。
12. context budget超過時にtruncation metadataが返る。
13. `$workbench-project` がcontext-first workflowを実行する。

## 14. Completion criteria

- Gate 0 contractが承認済み。
- Projects / Core / UI / Skillの承認checklistを満たす。
- full buildが成功する。
- high-risk test（owner isolation、membership lifecycle、Project delete guard、brief conflict、relation integrity、index drift）が成功する。
- docsと実装済みtool schemaが一致する。
- root agentが各feature commitを作成し、未解決事項をfollow-upとして記録する。
