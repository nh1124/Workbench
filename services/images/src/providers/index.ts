import type { ImageProviderCredentials, ImageSize, ResolvedImageProvider } from "../types.js";
import type { ImageProviderAdapter, ProviderGenerateInput, ProviderGenerateResult } from "./types.js";
import { ImageProviderError } from "./types.js";
import { mockProvider } from "./mock.js";
import { nanoBananaProvider } from "./nanobanana.js";
import { openAiProvider } from "./openai.js";

const adapters: Record<ResolvedImageProvider, ImageProviderAdapter> = {
  mock: mockProvider,
  openai: openAiProvider,
  nanobanana: nanoBananaProvider
};

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function adapterCapabilities(): Record<ResolvedImageProvider, ImageProviderAdapter["capabilities"]> {
  return {
    mock: mockProvider.capabilities,
    openai: openAiProvider.capabilities,
    nanobanana: nanoBananaProvider.capabilities
  };
}

export function resolveProvider(input: {
  requested?: string;
  credentials?: ImageProviderCredentials;
}): ResolvedImageProvider {
  const requested = input.requested;
  if (requested === "mock" || requested === "openai" || requested === "nanobanana") {
    return requested;
  }

  const configuredDefault = input.credentials?.defaultProvider ?? optionalEnv("IMAGES_DEFAULT_PROVIDER");
  if (configuredDefault === "openai" && input.credentials?.openaiApiKey) return "openai";
  if (configuredDefault === "nanobanana" && input.credentials?.nanobananaApiKey) return "nanobanana";
  if (configuredDefault === "mock") return "mock";

  if (input.credentials?.openaiApiKey) return "openai";
  if (input.credentials?.nanobananaApiKey) return "nanobanana";
  return "mock";
}

export function resolveModel(provider: ResolvedImageProvider, explicitModel?: string, credentials?: ImageProviderCredentials): string {
  if (explicitModel?.trim()) return explicitModel.trim();
  if (provider === "openai") {
    return credentials?.defaultOpenAIModel?.trim() || optionalEnv("IMAGES_DEFAULT_OPENAI_MODEL") || "gpt-image-1.5";
  }
  if (provider === "nanobanana") {
    return credentials?.defaultNanobananaModel?.trim() || optionalEnv("IMAGES_DEFAULT_NANOBANANA_MODEL") || "nanobanana";
  }
  return "workbench-mock-image";
}

export function normalizeImageSize(size?: string): ImageSize {
  if (
    size === "512x512" ||
    size === "768x768" ||
    size === "1024x1024" ||
    size === "1024x1536" ||
    size === "1536x1024" ||
    size === "auto"
  ) {
    return size;
  }
  return "1024x1024";
}

export async function runProvider(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
  const adapter = adapters[input.provider];
  if (!adapter) {
    throw new ImageProviderError(`Unsupported image provider: ${input.provider}`, "INVALID_INPUT", 400);
  }
  return adapter.generate(input);
}
