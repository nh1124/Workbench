import type { ImageProviderAdapter, ProviderGenerateInput, ProviderGenerateResult } from "./types.js";
import { ImageProviderError } from "./types.js";

type OpenAIImagePayload = {
  created?: number;
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

function mapQuality(quality: string): "low" | "medium" | "high" {
  if (quality === "draft") return "low";
  if (quality === "high") return "high";
  return "medium";
}

function normalizeSize(size: string): string {
  if (size === "512x512" || size === "768x768") return "1024x1024";
  return size;
}

function buildPrompt(input: ProviderGenerateInput): string {
  const lines = [input.prompt.trim()];
  if (input.instruction?.trim()) {
    lines.push("", `Instruction: ${input.instruction.trim()}`);
  }
  if (input.contextSummary?.trim()) {
    lines.push("", `Workbench context: ${input.contextSummary.trim()}`);
  }
  if (input.preserve?.length) {
    lines.push("", `Preserve: ${input.preserve.join(", ")}`);
  }
  if (input.negativePrompt?.trim()) {
    lines.push("", `Avoid: ${input.negativePrompt.trim()}`);
  }
  return lines.join("\n");
}

async function readOpenAIJson(response: Response): Promise<OpenAIImagePayload> {
  const text = await response.text();
  let parsed: OpenAIImagePayload = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as OpenAIImagePayload;
    } catch {
      throw new ImageProviderError(`OpenAI returned invalid JSON (HTTP ${response.status})`, "PROVIDER_EXECUTION_FAILED", 502);
    }
  }

  if (!response.ok) {
    const message = parsed.error?.message || text || `HTTP ${response.status}`;
    const code = response.status === 429 ? "PROVIDER_RATE_LIMITED" : response.status === 400 ? "PROVIDER_REJECTED" : "PROVIDER_EXECUTION_FAILED";
    throw new ImageProviderError(`OpenAI request failed: ${message}`, code, response.status);
  }

  return parsed;
}

async function downloadHttpsImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageProviderError("OpenAI returned an invalid image URL", "IMAGE_DOWNLOAD_FAILED", 502);
  }
  if (parsed.protocol !== "https:") {
    throw new ImageProviderError("OpenAI returned a non-HTTPS image URL", "IMAGE_DOWNLOAD_FAILED", 502);
  }

  const response = await fetch(parsed.toString(), { signal });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new ImageProviderError(`Image download failed: HTTP ${response.status}`, "IMAGE_DOWNLOAD_FAILED", 502);
  }
  return buffer;
}

async function extractImages(payload: OpenAIImagePayload, signal?: AbortSignal) {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const images = [];
  for (const item of data) {
    if (item.b64_json) {
      images.push({
        buffer: Buffer.from(item.b64_json, "base64"),
        mimeType: payload.output_format === "jpeg" ? "image/jpeg" : payload.output_format === "webp" ? "image/webp" : "image/png",
        metadata: {
          revisedPrompt: item.revised_prompt,
          usage: payload.usage,
          quality: payload.quality,
          size: payload.size
        }
      });
    } else if (item.url) {
      images.push({
        buffer: await downloadHttpsImage(item.url, signal),
        mimeType: "image/png",
        originalProviderUrl: item.url,
        metadata: {
          revisedPrompt: item.revised_prompt,
          usage: payload.usage,
          quality: payload.quality,
          size: payload.size
        }
      });
    }
  }
  if (images.length === 0) {
    throw new ImageProviderError("OpenAI returned no image data", "PROVIDER_EXECUTION_FAILED", 502);
  }
  return images;
}

async function generateFromPrompt(input: ProviderGenerateInput, apiKey: string): Promise<ProviderGenerateResult> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    signal: input.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      prompt: buildPrompt(input),
      n: Math.max(1, Math.min(10, input.count)),
      size: normalizeSize(input.size),
      quality: mapQuality(input.quality),
      output_format: "png"
    })
  });

  const payload = await readOpenAIJson(response);
  return {
    provider: "openai",
    model: input.model,
    images: await extractImages(payload, input.signal),
    metadata: {
      created: payload.created,
      usage: payload.usage
    }
  };
}

async function editFromImages(input: ProviderGenerateInput, apiKey: string): Promise<ProviderGenerateResult> {
  const formData = new FormData();
  formData.append("model", input.model);
  formData.append("prompt", buildPrompt(input));
  formData.append("n", String(Math.max(1, Math.min(10, input.count))));
  formData.append("size", normalizeSize(input.size));
  formData.append("quality", mapQuality(input.quality));
  formData.append("output_format", "png");

  const imageInputs = input.images.filter((image) => image.purpose !== "mask").slice(0, 16);
  for (const image of imageInputs) {
    formData.append("image", new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }), image.fileName);
  }
  const mask = input.images.find((image) => image.purpose === "mask");
  if (mask) {
    formData.append("mask", new Blob([new Uint8Array(mask.buffer)], { type: mask.mimeType }), mask.fileName);
  }

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  const payload = await readOpenAIJson(response);
  return {
    provider: "openai",
    model: input.model,
    images: await extractImages(payload, input.signal),
    metadata: {
      created: payload.created,
      usage: payload.usage
    }
  };
}

export const openAiProvider: ImageProviderAdapter = {
  provider: "openai",
  capabilities: ["create", "refine", "edit", "context_update", "reference", "source"],
  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const apiKey = input.credentials?.openaiApiKey?.trim();
    if (!apiKey) {
      throw new ImageProviderError("OpenAI API key is not configured", "MISSING_PROVIDER_KEY", 400);
    }
    if (input.images.length > 0 || input.intent === "refine" || input.intent === "edit" || input.intent === "context_update") {
      return editFromImages(input, apiKey);
    }
    return generateFromPrompt(input, apiKey);
  }
};
