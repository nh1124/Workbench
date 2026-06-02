import type {
  ImageIntent,
  ImagePreserveHint,
  ImageProviderCredentials,
  ImageQuality,
  ImageSize,
  ResolvedImageProvider
} from "../types.js";

export interface ProviderImageInput {
  id: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  purpose: "reference" | "source" | "mask";
}

export interface ProviderGenerateInput {
  provider: ResolvedImageProvider;
  model: string;
  intent: ImageIntent;
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  size: ImageSize;
  count: number;
  quality: ImageQuality;
  stylePreset?: string;
  seed?: number;
  preserve?: ImagePreserveHint[];
  contextSummary?: string;
  images: ProviderImageInput[];
  credentials?: ImageProviderCredentials;
  signal?: AbortSignal;
}

export interface ProviderImageOutput {
  buffer: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  originalProviderUrl?: string;
}

export interface ProviderGenerateResult {
  provider: ResolvedImageProvider;
  model: string;
  images: ProviderImageOutput[];
  metadata?: Record<string, unknown>;
}

export interface ImageProviderAdapter {
  provider: ResolvedImageProvider;
  capabilities: Array<ImageIntent | "reference" | "source">;
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}

export class ImageProviderError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
