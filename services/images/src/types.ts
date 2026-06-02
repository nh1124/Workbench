export type ImageProvider = "auto" | "mock" | "openai" | "nanobanana";
export type ResolvedImageProvider = Exclude<ImageProvider, "auto">;
export type ImageIntent = "create" | "refine" | "edit" | "context_update";
export type ImageJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ImageQuality = "draft" | "standard" | "high";
export type ImageSize = "512x512" | "768x768" | "1024x1024" | "1024x1536" | "1536x1024" | "auto";
export type ImageReferencePurpose = "reference" | "source" | "mask";
export type ImagePreserveHint = "composition" | "subject" | "style" | "colors" | "text" | "layout";

export interface ImageContextRef {
  kind: "project" | "artifact" | "note" | "task" | "research" | "freeform";
  id?: string;
  title?: string;
  path?: string;
  content?: string;
}

export interface ImageContextSnapshot {
  refs: ImageContextRef[];
  summary?: string;
}

export interface ImageGenerationInput {
  intent?: ImageIntent;
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  provider?: ImageProvider;
  model?: string;
  size?: ImageSize;
  count?: number;
  quality?: ImageQuality;
  stylePreset?: string;
  seed?: number;
  referenceImageIds?: string[];
  sourceAssetIds?: string[];
  sourceArtifactItemIds?: string[];
  contextRefs?: ImageContextRef[];
  contextSnapshot?: ImageContextSnapshot;
  preserve?: ImagePreserveHint[];
  saveToArtifacts?: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
  providerCredentials?: ImageProviderCredentials;
}

export interface ImageProviderCredentials {
  openaiApiKey?: string;
  nanobananaApiKey?: string;
  nanobananaApiUrl?: string;
  defaultProvider?: ImageProvider;
  defaultOpenAIModel?: string;
  defaultNanobananaModel?: string;
}

export interface ImageProgress {
  stage: "queued" | "provider_running" | "saving_assets" | "completed" | "failed" | "cancelled";
  percent: number;
  message: string;
}

export interface ImageReferenceRecord {
  id: string;
  purpose: ImageReferencePurpose;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256: string;
  projectId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  deletedAt?: string;
}

export interface ImageAssetRecord {
  id: string;
  jobId: string;
  sourceAssetId?: string;
  sourceReferenceId?: string;
  indexInJob: number;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  artifactItemId?: string;
  artifactItemPath?: string;
  artifactTitle?: string;
  projectId?: string;
  projectName?: string;
  createdAt: string;
  deletedAt?: string;
  downloadUrl?: string;
}

export interface ImageJobRecord {
  jobId: string;
  status: ImageJobStatus;
  intent: ImageIntent;
  parentJobId?: string;
  provider: ResolvedImageProvider;
  model: string;
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  request: Record<string, unknown>;
  contextSnapshot?: ImageContextSnapshot;
  progress: ImageProgress;
  errorCode?: string;
  errorMessage?: string;
  saveToArtifacts: boolean;
  projectId?: string;
  projectName?: string;
  artifactTitle?: string;
  artifactPath?: string;
  assets: ImageAssetRecord[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface ImageGenerationResponse extends ImageJobRecord {
  status: ImageJobStatus;
}

export interface ImageDefaultsResponse {
  enabled: boolean;
  defaults: {
    provider: ImageProvider;
    model?: string;
    size: ImageSize;
    quality: ImageQuality;
    count: number;
    saveToArtifacts: boolean;
  };
  availableProviders: Record<ResolvedImageProvider, boolean>;
  capabilities: Record<ResolvedImageProvider, Array<ImageIntent | "reference" | "source">>;
}
