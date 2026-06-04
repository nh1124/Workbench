import type { ImageProviderAdapter, ProviderGenerateInput, ProviderGenerateResult } from "./types.js";
import { ImageProviderError } from "./types.js";

export const NANO_BANANA_MODELS = [
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    description: "Gemini 3.1 Flash Image"
  },
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    description: "Gemini 3 Pro Image"
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Nano Banana",
    description: "Gemini 2.5 Flash Image"
  }
] as const;

export const DEFAULT_NANO_BANANA_MODEL = NANO_BANANA_MODELS[0].id;

type NanoBananaPayload = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
        inline_data?: {
          data?: string;
          mime_type?: string;
        };
      }>;
    };
  }>;
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

function resolveNanoBananaModel(model: string): string {
  return NANO_BANANA_MODELS.some((option) => option.id === model) ? model : DEFAULT_NANO_BANANA_MODEL;
}

function buildEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`;
}

function buildPrompt(input: ProviderGenerateInput): string {
  return [
    input.prompt.trim(),
    input.instruction?.trim() ? `Instruction: ${input.instruction.trim()}` : undefined,
    input.contextSummary?.trim() ? `Context: ${input.contextSummary.trim()}` : undefined,
    input.preserve?.length ? `Preserve: ${input.preserve.join(", ")}` : undefined,
    input.negativePrompt?.trim() ? `Avoid: ${input.negativePrompt.trim()}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

function buildParts(input: ProviderGenerateInput): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(input) }];
  for (const image of input.images) {
    if (image.purpose === "mask") continue;
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.buffer.toString("base64")
      }
    });
  }
  return parts;
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

async function generateOne(input: ProviderGenerateInput, apiKey: string, model: string, index: number) {
    const response = await fetch(buildEndpoint(model), {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              ...buildParts(input),
              ...(input.count > 1 ? [{ text: `Variant ${index + 1} of ${input.count}. Create a distinct option while following the same requirements.` }] : [])
            ]
          }
        ]
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
    for (const candidate of payload.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        const inlineData = part.inlineData ?? (part.inline_data ? {
          data: part.inline_data.data,
          mimeType: part.inline_data.mime_type
        } : undefined);
        if (inlineData?.data) {
          images.push({
            buffer: Buffer.from(inlineData.data, "base64"),
            mimeType: inlineData.mimeType ?? "image/png",
            metadata: {}
          });
        }
      }
    }
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

    return images;
}

export const nanoBananaProvider: ImageProviderAdapter = {
  provider: "nanobanana",
  capabilities: ["create", "refine", "edit", "context_update", "reference", "source"],
  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const apiKey = input.credentials?.nanobananaApiKey?.trim();
    const model = resolveNanoBananaModel(input.model);
    if (!apiKey) {
      throw new ImageProviderError("Nano Banana API key is not configured", "MISSING_PROVIDER_KEY", 400);
    }

    const count = Math.max(1, Math.min(8, Math.round(input.count)));
    const batches = await Promise.all(
      Array.from({ length: count }, (_value, index) => generateOne(input, apiKey, model, index))
    );
    const images = batches.flat();

    return {
      provider: "nanobanana",
      model,
      images,
      metadata: {}
    };
  }
};
