# Image Generation Service 草案

## 1. 目的

Workbench に画像生成機能を追加する。Artifacts と同様に独立した internal microservice として `services/images` を置き、UI / MCP / 外部クライアントは Workbench Core の facade だけを呼ぶ。

対象モデルは Nano Banana 系、OpenAI 画像生成系、将来の Gemini / Stability / local model などを想定する。ただしモデル固有の差分は provider adapter に閉じ込め、上位 API は「画像生成ジョブ」と「生成画像アセット」の共通契約で扱う。

基本フロー:

```text
UI / MCP / Agent
  -> Workbench Core (/api/images, MCP image tools)
  -> Images Service (jobs, providers, binary storage)
  -> Provider APIs
  -> Images Service storage
  -> optional export to Artifacts
```

## 2. 方針

- Core は認証、外部 HTTP facade、MCP tool registration を担当する。
- Images service は生成ジョブ、provider 呼び出し、画像バイナリ保存、履歴、利用量メタデータを担当する。
- 生成結果はまず Images service に保存する。
- Artifacts は「成果物として保存したい画像」の永続的な整理先として使う。
- 長時間実行、リトライ、キャンセル、進捗取得を前提に、同期完了だけに依存しない。
- provider/model は設定で差し替える。コードに特定モデル ID を固定しない。

## 3. In Scope

- Text-to-image
- Image-to-image / reference image input
- 生成済み画像やアップロード画像をもとにした iterative refinement
- Workbench の文脈（Project / Artifact / Note / Task / Research result）をもとにした画像更新
- 変更指示による edit / variation / style transfer
- 複数候補生成
- ジョブ履歴、ステータス、キャンセル
- 生成画像の download / inline preview
- 生成結果の Artifacts への保存
- UI からの生成、履歴閲覧、再実行
- MCP tool からの生成、結果取得、Artifacts 保存
- provider adapter: `nanobanana`, `openai`

## 4. Out of Scope 初期版

- 動画生成
- 画像編集の高度な mask editor
- リアルタイム collaborative editing
- 課金・クレジットの厳密な enforcement
- ローカル GPU worker
- provider ごとの全オプション完全対応

## 5. 推奨サービス構成

新規サービス:

```text
services/images/
  src/
    httpServer.ts
    auth.ts
    db.ts
    store.ts
    providers/
      index.ts
      types.ts
      openai.ts
      nanobanana.ts
    storage.ts
    types.ts
  data/
  storage/
  package.json
  tsconfig.json
  .env.example
  Dockerfile
```

Core 側追加:

```text
services/workbench-core/src/internalClients.ts
services/workbench-core/src/httpServer.ts
services/workbench-core/src/mcp/registerImageTools.ts
services/workbench-core/src/integrations/manifests/imageGenerationManifest.ts
services/workbench-core/src/integrations/types.ts
services/workbench-core/src/integrations/manifests/catalog.ts
```

UI 側追加:

```text
ui/src/pages/ImageGenerationPage.tsx
ui/src/pages/ImageGenerationPage.css
ui/src/images/types.ts
ui/src/images/hooks/useImageGeneration.ts
ui/src/lib/api.ts
ui/src/App.tsx
```

Infra 追加:

```text
infra/workbench.env.example
infra/env_samples/images.env.example
docker-compose.yml
package.json
```

推奨ポート:

- Images service: `4105`
- Images DB: `5547`

## 6. 認証とアカウント

既存サービスと同じ契約にそろえる。

- `POST /internal/accounts`
  - `x-api-key` 必須
  - body: `{ coreUserId, username }`
- business routes
  - `Authorization: Bearer <access token>` 必須
  - service-local account を `core_user_id` で解決

provider API key は初期版では Core の integration config に保持し、Core から Images service へジョブ開始時に provider credential snapshot を渡す案が実装しやすい。ただし security boundary を強めるなら Images service 側にも encrypted credential store を持たせる。

推奨初期案:

- UI 設定画面は Core の `integrations/configs/image_generation` を編集する。
- Core は Images service へ request を委譲する前に、ユーザーの設定から provider key を解決する。
- Images service には生の key を保存せず、ジョブ実行中だけ adapter に渡す。
- ジョブ履歴には provider, model, size, count, timing, error code は保存するが、API key と raw provider response は保存しない。

## 7. Provider 抽象

上位 API は provider 差分を吸収する。

```ts
export type ImageProvider = "auto" | "nanobanana" | "openai";

export interface ImageGenerationRequest {
  intent?: "create" | "refine" | "edit" | "context_update";
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  provider?: ImageProvider;
  model?: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  count?: number;
  quality?: "draft" | "standard" | "high";
  stylePreset?: string;
  seed?: number;
  referenceImageIds?: string[];
  sourceAssetIds?: string[];
  sourceArtifactItemIds?: string[];
  contextRefs?: ImageContextRef[];
  preserve?: Array<"composition" | "subject" | "style" | "colors" | "text" | "layout">;
  saveToArtifacts?: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
}

export interface ImageContextRef {
  kind: "project" | "artifact" | "note" | "task" | "research" | "freeform";
  id?: string;
  title?: string;
  path?: string;
  content?: string;
}

export interface ImageProviderAdapter {
  provider: Exclude<ImageProvider, "auto">;
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}
```

Provider adapter の責務:

- provider 固有 request shape への変換
- `create` / `refine` / `edit` / `context_update` intent の provider 別 capability 判定
- response から画像 binary / URL / base64 を抽出
- provider error の正規化
- request timeout / abort 対応
- safety rejection の共通 error code 化

共通 error code 例:

- `MISSING_PROVIDER_KEY`
- `INVALID_INPUT`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_REJECTED`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_EXECUTION_FAILED`
- `IMAGE_DOWNLOAD_FAILED`
- `JOB_NOT_FOUND`
- `JOB_CANCELLED`

## 8. Images Service API

Internal service routes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | health check |
| `POST` | `/internal/accounts` | Core user provisioning |
| `GET` | `/images/defaults` | provider availability and defaults |
| `POST` | `/images/references` | upload reference/source image |
| `POST` | `/images/generations` | start image generation |
| `GET` | `/images/generations` | list generation history |
| `GET` | `/images/generations/:jobId` | get job status/detail |
| `POST` | `/images/generations/:jobId/cancel` | cancel running job |
| `POST` | `/images/generations/:jobId/retry` | retry with same or patched input |
| `GET` | `/images/assets/:assetId` | asset metadata |
| `GET` | `/images/assets/:assetId/download` | binary download / inline preview |
| `DELETE` | `/images/assets/:assetId` | delete generated asset |
| `POST` | `/images/assets/:assetId/artifact` | save one asset to Artifacts |

Core facade:

| Method | Path |
|---|---|
| `GET` | `/api/images/defaults` |
| `POST` | `/api/images/references` |
| `POST` | `/api/images/generations` |
| `GET` | `/api/images/generations` |
| `GET` | `/api/images/generations/:jobId` |
| `POST` | `/api/images/generations/:jobId/cancel` |
| `POST` | `/api/images/generations/:jobId/retry` |
| `GET` | `/api/images/assets/:assetId` |
| `GET` | `/api/images/assets/:assetId/download` |
| `DELETE` | `/api/images/assets/:assetId` |
| `POST` | `/api/images/assets/:assetId/artifact` |

### 8.1 生成開始

`POST /images/generations`

```json
{
  "intent": "create",
  "prompt": "A clean product photo of a ceramic coffee dripper on a white table",
  "provider": "auto",
  "model": "default",
  "size": "1024x1024",
  "count": 2,
  "quality": "standard",
  "referenceImageIds": [],
  "saveToArtifacts": false,
  "projectId": "default"
}
```

Response completed:

```json
{
  "status": "completed",
  "jobId": "imgjob_...",
  "provider": "openai",
  "model": "configured-model",
  "assets": [
    {
      "id": "imgasset_...",
      "mimeType": "image/png",
      "width": 1024,
      "height": 1024,
      "downloadUrl": "/api/images/assets/imgasset_.../download"
    }
  ],
  "createdAt": "2026-05-28T00:00:00.000Z",
  "completedAt": "2026-05-28T00:00:10.000Z"
}
```

Response async:

```json
{
  "status": "running",
  "jobId": "imgjob_...",
  "provider": "nanobanana",
  "model": "configured-model",
  "progress": {
    "stage": "provider_running",
    "percent": 25,
    "message": "Generating image"
  },
  "statusUrl": "/api/images/generations/imgjob_..."
}
```

### 8.2 参照画像アップロード

`POST /images/references`

multipart form-data:

- `file`: reference image
- `purpose`: `reference` | `source` | `mask`
- `projectId`: optional

Response:

```json
{
  "id": "imgref_...",
  "purpose": "reference",
  "mimeType": "image/png",
  "width": 1024,
  "height": 1024,
  "sizeBytes": 824100,
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

`reference` は「雰囲気・スタイル・構図の参考」、`source` は「この画像を編集・ブラッシュアップする元画像」、`mask` は「編集対象範囲」を表す。MVP では `reference` と `source` を優先し、mask editor は後続に回す。

### 8.3 ブラッシュアップ / コンテキスト更新

既存画像を育てる操作は `POST /images/generations` の `intent` で表現する。新しい job と asset を作り、元画像との lineage を metadata に残す。

#### ブラッシュアップ

```json
{
  "intent": "refine",
  "sourceAssetIds": ["imgasset_..."],
  "prompt": "Make this more polished and production-ready.",
  "instruction": "Keep the same subject and composition, improve lighting, material realism, and remove small artifacts.",
  "preserve": ["subject", "composition", "colors"],
  "quality": "high",
  "count": 2
}
```

#### コンテキスト更新

```json
{
  "intent": "context_update",
  "sourceAssetIds": ["imgasset_..."],
  "prompt": "Update the hero image to match the current project direction.",
  "instruction": "Reflect the new brand tone and product copy while keeping the layout similar.",
  "contextRefs": [
    {
      "kind": "project",
      "id": "project_...",
      "title": "Coffee Tools Launch"
    },
    {
      "kind": "artifact",
      "id": "artifact_item_...",
      "path": "brand/visual-direction.md"
    }
  ],
  "preserve": ["layout", "subject"]
}
```

Core は `contextRefs` を解決して、Images service に渡す前に必要最小限の context snapshot を組み立てる。Images service は snapshot を job metadata に保存するが、巨大な artifact content や機密情報を丸ごと残さない。

### 8.4 ステータス

`GET /images/generations/:jobId`

```json
{
  "jobId": "imgjob_...",
  "status": "completed",
  "prompt": "A clean product photo...",
  "provider": "openai",
  "model": "configured-model",
  "progress": {
    "stage": "completed",
    "percent": 100,
    "message": "Completed"
  },
  "assets": [],
  "artifactRefs": [],
  "errorMessage": null,
  "createdAt": "2026-05-28T00:00:00.000Z",
  "updatedAt": "2026-05-28T00:00:10.000Z"
}
```

## 9. DB 草案

PostgreSQL を基本に、画像 binary は service-local storage に置く。metadata は DB、binary は filesystem volume か object storage compatible backend へ分離する。

### `service_accounts`

既存 internal service と同様。

```sql
CREATE TABLE service_accounts (
  id TEXT PRIMARY KEY,
  core_user_id TEXT UNIQUE NOT NULL,
  username_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `image_generation_jobs`

```sql
CREATE TABLE image_generation_jobs (
  id TEXT PRIMARY KEY,
  owner_core_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'create',
  parent_job_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  instruction TEXT,
  negative_prompt TEXT,
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  save_to_artifacts BOOLEAN NOT NULL DEFAULT false,
  project_id TEXT,
  project_name TEXT,
  artifact_title TEXT,
  artifact_path TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_image_jobs_owner_updated
  ON image_generation_jobs(owner_core_user_id, updated_at DESC);
```

`intent` は `create` / `refine` / `edit` / `context_update`。`parent_job_id` は再実行やブラッシュアップの親を表す。`context_snapshot_json` には Core が解決した短い context summary、参照元 id、content hash を保存する。

### `image_assets`

```sql
CREATE TABLE image_assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
  owner_core_user_id TEXT NOT NULL,
  source_asset_id TEXT,
  source_reference_id TEXT,
  index_in_job INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_provider_url TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_item_id TEXT,
  artifact_item_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_image_assets_owner_created
  ON image_assets(owner_core_user_id, created_at DESC);
```

`source_asset_id` / `source_reference_id` は lineage 表示と rollback に使う。複数 source を扱う場合は `metadata_json.sourceAssetIds` にも保持する。

### `image_references`

```sql
CREATE TABLE image_references (
  id TEXT PRIMARY KEY,
  owner_core_user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  project_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_image_references_owner_created
  ON image_references(owner_core_user_id, created_at DESC);
```

`purpose` は `reference` / `source` / `mask`。初期版では `reference` と `source` を実装し、`mask` は endpoint 契約だけ残して UI は後続でもよい。

### `image_job_inputs`

```sql
CREATE TABLE image_job_inputs (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
  owner_core_user_id TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  input_id TEXT,
  input_summary TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`input_kind` は `reference_image` / `source_asset` / `artifact` / `project` / `note` / `task` / `research` / `freeform`。どの context をもとに更新したかを audit 可能にする。

### `image_job_events`

```sql
CREATE TABLE image_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
  owner_core_user_id TEXT NOT NULL,
  level TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 10. Storage 草案

初期版は filesystem volume:

```text
services/images/storage/
  {ownerHash}/
    assets/
      {assetId}.png
    references/
      {referenceId}.png
    masks/
      {maskId}.png
```

将来 object storage に切り替えやすいように `storage.ts` で抽象化する。

```ts
export interface ImageStorage {
  putAsset(input: PutAssetInput): Promise<StoredImageAsset>;
  readAsset(storageKey: string): Promise<{ buffer: Buffer; mimeType: string }>;
  deleteAsset(storageKey: string): Promise<void>;
}
```

`ownerHash` は raw user id を path に出さないための hash。`sha256` は重複検知と audit に使う。

## 11. Artifacts 連携

生成画像を Artifacts に保存する方式は 2 案ある。

### 案 A: Core 経由で Artifacts に upload

Images service は binary を返す。Core が `artifactsClient.uploadFile` を呼ぶ。

利点:

- service 間の横連携が Core に集約される。
- 既存の `artifactsClient` を使える。
- Images service が Artifacts の API key / URL を知らなくてよい。

欠点:

- 大きい画像の binary が Images -> Core -> Artifacts と流れる。

### 案 B: Images service が Artifacts service を直接呼ぶ

Images service に `ARTIFACTS_SERVICE_URL` と internal integration を追加する。

利点:

- Core の処理が薄い。
- auto-save を Images service 内で完結できる。

欠点:

- service 間依存が増える。
- retry / auth / provisioning の責務が散る。

初期推奨は案 A。Deep Research が Core で Artifacts 保存している既存パターンとも近い。

Artifacts 保存時の filename 例:

```text
images/{yyyy-mm-dd}/{slugified-prompt}-{assetId}.png
```

Artifact tags 例:

```text
["image-generation", provider, model, "generated"]
```

## 12. Context 解決

コンテキスト更新では、Images service が Projects / Artifacts / Notes / Tasks を直接読みに行かない。Core が `contextRefs` を解決し、Images service には provider prompt に使える短い snapshot を渡す。

Core の責務:

- `project` ref から project title / summary / linked item ids を解決する。
- `artifact` ref から title / path / relevant excerpt / mime type を解決する。
- `note` / `task` / `research` ref から画像更新に必要な短い要約を作る。
- 長すぎる本文は provider prompt 用に要約し、snapshot には hash と excerpt を残す。
- ユーザー権限を Core の既存 auth context で検証する。

Images service の責務:

- context snapshot を job record に保存する。
- provider adapter に渡す generation context を組み立てる。
- lineage と audit のため、`image_job_inputs` に参照元を保存する。

context snapshot 例:

```json
{
  "refs": [
    {
      "kind": "artifact",
      "id": "artifact_item_...",
      "title": "Visual Direction",
      "path": "brand/visual-direction.md",
      "excerpt": "Use bright natural light, ceramic textures, and minimal composition.",
      "contentHash": "sha256:..."
    }
  ],
  "summary": "The image should follow the project's natural, minimal coffee-tool visual direction."
}
```

## 13. MCP Tools 草案

Core MCP に以下を追加する。

| Tool | Description |
|---|---|
| `images.generate` | 画像生成ジョブを開始。短時間で完了すれば assets を返す |
| `images.reference.upload` | reference/source image を登録 |
| `images.status` | job status/detail を取得 |
| `images.history` | generation history を取得 |
| `images.refine` | 既存 asset をもとにブラッシュアップ |
| `images.contextUpdate` | Project / Artifact 等の文脈をもとに既存 asset を更新 |
| `images.cancel` | running job を cancel |
| `images.asset.get` | asset metadata を取得 |
| `images.asset.download` | base64 image content を返す |
| `images.asset.saveArtifact` | asset を Artifacts に保存 |

`images.generate` は MCP payload が重くなりすぎないよう、デフォルトでは binary を返さず `assetId` と `download` tool の案内を返す。必要な場合だけ `returnBase64: true` を許可する。

## 14. UI 草案

`/images` ページを追加する。

主要領域:

- Prompt editor
- Provider / model / size / count / quality controls
- Reference images uploader
- Source image selector（生成済み asset / upload / Artifacts から選択）
- Refinement controls（preserve, strength, quality, variations）
- Context picker（Project / Artifact / Note / Task / Research result）
- Generate button
- Running job progress
- Result grid
- History sidebar
- Asset actions: download, copy prompt, retry, save to Artifacts, delete

初期 UX:

- 生成中は card placeholder と progress を表示。
- provider key 未設定時は Settings への導線を表示。
- result grid は画像そのものを主役にし、周辺 metadata は折りたたみ気味にする。
- save to Artifacts は生成時 toggle と asset 単位 action の両方を用意する。
- ブラッシュアップ時は元画像と新画像を並べて比較できるようにする。
- コンテキスト更新時は「参照された context」と「保持する要素」を明示し、意図しない大幅変更を避ける。

## 15. Integration Manifest 草案

`image_generation` を追加する。

```ts
export const imageGenerationManifest: IntegrationManifest = {
  id: "image_generation",
  displayName: "Image Generation",
  description: "Provider keys and defaults for image generation.",
  category: "integration",
  defaultEnabled: true,
  badge: "Core",
  fields: [
    { key: "nanobananaApiKey", label: "Nano Banana API Key", type: "password" },
    { key: "openaiApiKey", label: "OpenAI API Key", type: "password" },
    {
      key: "defaultProvider",
      label: "Default Provider",
      type: "select",
      defaultValue: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Nano Banana", value: "nanobanana" },
        { label: "OpenAI", value: "openai" }
      ]
    },
    { key: "defaultModelNanobanana", label: "Nano Banana Model", type: "text" },
    { key: "defaultModelOpenAI", label: "OpenAI Image Model", type: "text" },
    { key: "defaultSize", label: "Default Size", type: "select", defaultValue: "1024x1024" },
    { key: "defaultQuality", label: "Default Quality", type: "select", defaultValue: "standard" },
    { key: "defaultSaveToArtifacts", label: "Default Save To Artifacts", type: "boolean", defaultValue: false }
  ]
};
```

注意: 現在の `IntegrationManifestId` は union literal なので、`image_generation` を追加すると型定義と catalog 更新が必要。

## 16. 非同期実行

初期版は process-local background execution でよい。ただしジョブは DB に保存し、process restart 時に `running` のまま古くなったジョブを `failed` または `interrupted` に遷移できるようにする。

推奨ステータス:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

将来 Redis / queue service を入れる場合も、HTTP API と DB schema を大きく変えずに worker だけ差し替える。

## 17. セキュリティ・安全性

- API key は logs / job metadata に出さない。
- Prompt と生成結果はユーザー所有データとして owner scope を必須にする。
- Download endpoint は bearer auth 必須。
- Provider error response は保存しすぎない。HTML や巨大 JSON は正規化する。
- Reference image upload は mime type と size limit を設ける。
- 初期 upload limit は 25MB 程度で Artifacts と揃える。
- 生成画像の content type は allowlist: `image/png`, `image/jpeg`, `image/webp`。
- SSRF 回避のため、provider が返した URL を service が download する場合は private IP / localhost を拒否する。

## 18. Observability

最低限:

- job created / started / completed / failed / cancelled logs
- provider latency
- generated asset count
- provider error code
- storage write failure
- artifact save failure

将来:

- per-provider success rate
- per-model average latency
- monthly asset storage size
- optional usage/cost estimates

## 19. 段階実装

### Phase 0: 契約固定

- この草案をもとに API request/response と DB schema を固定。
- `image_generation` integration manifest を追加する方針を決める。
- `saveToArtifacts` を Core 側責務にするか Images service 側責務にするか決める。

完了条件:

- OpenAPI 相当の route table と型が合意済み。

### Phase 1: Images service skeleton

- `services/images` 作成。
- health, auth, internal account, DB schema, storage abstraction。
- history / status / asset download のダミー実装。
- infra/env/docker/npm scripts へ追加。

完了条件:

- Core なしで service 単体 health と basic DB migration が通る。

### Phase 2: Core facade

- `imagesClient` を `internalClients.ts` に追加。
- `/api/images/*` routes 追加。
- integration manifest 追加。
- Settings で provider key と defaults を保存できる。

完了条件:

- UI または curl から Core 経由で dummy generation job を作成・取得できる。

### Phase 3: Provider adapters

- `openai` adapter 実装。
- `nanobanana` adapter 実装。
- provider auto routing。
- provider capability matrix（text-to-image / reference / refine / edit / context_update）実装。
- timeout / cancel / error normalization。

完了条件:

- 少なくとも 1 provider で実画像が生成され、asset download できる。
- reference/source image を使う generation が少なくとも 1 provider で通る。

### Phase 4: Artifacts export

- asset を Artifacts upload に変換。
- auto-save と manual save を実装。
- artifact ref を image asset / job に保存。

完了条件:

- 生成画像を Artifacts ページから開ける。

### Phase 5: UI

- `/images` ページ。
- generate form, source/reference selector, context picker, result grid, history, asset actions。
- Settings への導線。
- エラー、empty、loading、cancel 状態。

完了条件:

- UI だけで生成から Artifacts 保存まで完結できる。
- UI だけで既存画像のブラッシュアップと context update が実行できる。

### Phase 6: MCP tools

- `registerImageTools.ts` 追加。
- generate/refine/contextUpdate/status/history/download/saveArtifact。
- `createMcpServerInstance` に登録。

完了条件:

- MCP client から画像生成し、asset id を取得し、必要なら Artifacts 保存できる。
- MCP client から source asset と context refs を指定して更新できる。

## 20. リスクと決めたいこと

- Provider API の response 形式差分が大きい。
  - 対策: adapter 内に閉じ込め、上位は binary asset list だけを見る。
- 画像生成は長時間化しやすい。
  - 対策: sync timeout 後も job id で追える形にする。
- 画像 binary が Core を経由すると重い。
  - 対策: 初期は単純さ優先。負荷が見えたら signed internal transfer / object storage へ移行。
- API key の所在。
  - 対策: 初期は Core integration config。将来は provider credential service か Images service encrypted store。
- Nano Banana の正式 API 名称やモデル ID が変わり得る。
  - 対策: provider id は `nanobanana` のままでも、model id と endpoint は env/config 化する。

## 21. 最小 MVP

MVP は以下に絞る。

- `services/images` + Postgres + filesystem storage
- `openai` と `nanobanana` の provider adapter 枠
- まず 1 provider で text-to-image と reference/source image generation を実動
- `POST /api/images/generations`
- `POST /api/images/references`
- `GET /api/images/generations/:jobId`
- `GET /api/images/assets/:assetId/download`
- `/images` UI で prompt -> generate -> preview
- `/images` UI で source image -> refine -> compare
- 手動 `Save to Artifacts`

この範囲なら既存アーキテクチャを崩さず、後から高度な mask editor、複数 provider、MCP、queue worker を足しやすい。
