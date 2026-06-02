import type { ImageProviderAdapter, ProviderGenerateInput, ProviderGenerateResult } from "./types.js";
import { ImageProviderError } from "./types.js";

type NanoBananaPayload = {
  images?: Array<{
    b64_json?: string;
    base64?: string;
    url?: string;
    mime_type?: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
  data?: Array<{
    b64_json?: string;
    base64?: string;
    url?: string;
    mime_type?: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
  error?: {
    message?: string;
    code?: string;
  };
  message?: string;
};

function buildPrompt(input: ProviderGenerateInput): string {
  return [
    input.prompt.trim(),
    input.instruction?.trim() ? `Instruction: ${input.instruction.trim()}` : undefined,
    input.contextSummary?.trim() ? `Context: ${input.contextSummary.trim()}` : undefined,
    input.preserve?.length ? `Preserve: ${input.preserve.join(", ")}` : undefined,
    input.negativePrompt?.trim() ? `Avoid: ${input.negativePrompt.trim()}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

async function downloadHttpsImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new ImageProviderError("Nano Banana returned a non-HTTPS image URL", "IMAGE_DOWNLOAD_FAILED", 502);
  }
  const response = await fetch(parsed, { signal });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new ImageProviderError(`Image download failed: HTTP ${response.status}`, "IMAGE_DOWNLOAD_FAILED", 502);
  }
  return buffer;
}

export const nanoBananaProvider: ImageProviderAdapter = {
  provider: "nanobanana",
  capabilities: ["create", "refine", "edit", "context_update", "reference", "source"],
  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const apiKey = input.credentials?.nanobananaApiKey?.trim();
    const endpoint = input.credentials?.nanobananaApiUrl?.trim() || process.env.NANOBANANA_API_URL?.trim();
    if (!apiKey) {
      throw new ImageProviderError("Nano Banana API key is not configured", "MISSING_PROVIDER_KEY", 400);
    }
    if (!endpoint) {
      throw new ImageProviderError("Nano Banana API URL is not configured", "PROVIDER_UNAVAILABLE", 400);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        intent: input.intent,
        prompt: buildPrompt(input),
        size: input.size,
        count: input.count,
        quality: input.quality,
        stylePreset: input.stylePreset,
        seed: input.seed,
        preserve: input.preserve,
        images: input.images.map((image) => ({
          id: image.id,
          purpose: image.purpose,
          mimeType: image.mimeType,
          base64: image.buffer.toString("base64")
        }))
      })
    });

    const text = await response.text();
    let payload: NanoBananaPayload = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as NanoBananaPayload;
      } catch {
        throw new ImageProviderError(`Nano Banana returned invalid JSON (HTTP ${response.status})`, "PROVIDER_EXECUTION_FAILED", 502);
      }
    }

    if (!response.ok) {
      const message = payload.error?.message || payload.message || text || `HTTP ${response.status}`;
      const code = response.status === 429 ? "PROVIDER_RATE_LIMITED" : response.status === 400 ? "PROVIDER_REJECTED" : "PROVIDER_EXECUTION_FAILED";
      throw new ImageProviderError(`Nano Banana request failed: ${message}`, code, response.status);
    }

    const imageRows = payload.images ?? payload.data ?? [];
    const images = [];
    for (const item of imageRows) {
      const encoded = item.b64_json ?? item.base64;
      if (encoded) {
        images.push({
          buffer: Buffer.from(encoded, "base64"),
          mimeType: item.mimeType ?? item.mime_type ?? "image/png",
          width: item.width,
          height: item.height,
          metadata: {}
        });
      } else if (item.url) {
        images.push({
          buffer: await downloadHttpsImage(item.url, input.signal),
          mimeType: item.mimeType ?? item.mime_type ?? "image/png",
          width: item.width,
          height: item.height,
          originalProviderUrl: item.url,
          metadata: {}
        });
      }
    }
    if (images.length === 0) {
      throw new ImageProviderError("Nano Banana returned no image data", "PROVIDER_EXECUTION_FAILED", 502);
    }

    return {
      provider: "nanobanana",
      model: input.model,
      images,
      metadata: {}
    };
  }
};
