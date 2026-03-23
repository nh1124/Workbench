import { DeepResearchError, ensureStringContent } from "./errors.js";
import type { DeepResearchProvider, DeepResearchProviderResult, DeepResearchSpeed } from "./types.js";

const MODEL_MAP: Record<DeepResearchProvider, Record<DeepResearchSpeed, string>> = {
  gemini: {
    deep: process.env.DEEP_RESEARCH_MODEL_GEMINI_DEEP?.trim() || "deep-research-pro-preview-12-2025",
    fast: process.env.DEEP_RESEARCH_MODEL_GEMINI_FAST?.trim() || "gemini-3-flash-preview"
  },
  openai: {
    deep: process.env.DEEP_RESEARCH_MODEL_OPENAI_DEEP?.trim() || "o3-deep-research",
    fast: process.env.DEEP_RESEARCH_MODEL_OPENAI_FAST?.trim() || "o4-mini-deep-research"
  },
  anthropic: {
    deep: process.env.DEEP_RESEARCH_MODEL_ANTHROPIC_DEEP?.trim() || "claude-opus-4-6",
    fast: process.env.DEEP_RESEARCH_MODEL_ANTHROPIC_FAST?.trim() || "claude-haiku-4-5"
  }
};

const OPENAI_FALLBACK_MODEL = process.env.DEEP_RESEARCH_MODEL_OPENAI_FALLBACK?.trim() || "gpt-5.4";
const GEMINI_DEEP_RESEARCH_AGENT_PREFIX = "deep-research-";
const GEMINI_INTERACTION_POLL_MS = 6000;

type JsonRecord = Record<string, unknown>;

function looksLikeHtml(payload: string): boolean {
  const text = payload.trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return true;
  return /<\s*(html|head|body|title|script|style)\b/i.test(payload);
}

function stripHtmlTags(payload: string): string {
  return payload
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProviderErrorBody(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;
  if (!looksLikeHtml(trimmed)) return trimmed;

  const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? stripHtmlTags(titleMatch[1]).slice(0, 120) : "";
  if (title) {
    return `HTTP ${status} (HTML error page: ${title})`;
  }

  return `HTTP ${status} (HTML error page)`;
}

function promptForResearch(query: string): string {
  return [
    "Conduct deep research on the user query.",
    "Return a concise but information-dense markdown report with:",
    "1) summary",
    "2) key findings",
    "3) notable sources or references if available",
    "4) risks/unknowns",
    "5) actionable next steps",
    "",
    `Query: ${query.trim()}`
  ].join("\n");
}

async function readJsonResponse(response: Response, provider: DeepResearchProvider): Promise<JsonRecord> {
  const text = await response.text();
  let parsed: JsonRecord | undefined;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text) as JsonRecord;
    } catch {
      parsed = undefined;
      if (looksLikeHtml(text)) {
        throw new DeepResearchError(
          `${provider} request failed: ${normalizeProviderErrorBody(text, response.status)}`,
          "PROVIDER_REQUEST_FAILED",
          response.status >= 400 ? response.status : 502
        );
      }
      throw new DeepResearchError(
        `${provider} request failed: invalid non-JSON response (HTTP ${response.status})`,
        "PROVIDER_REQUEST_FAILED",
        response.status >= 400 ? response.status : 502
      );
    }
  }

  if (!response.ok) {
    const normalizedBody = normalizeProviderErrorBody(text, response.status);
    const providerMessage =
      (parsed?.error as { message?: unknown } | undefined)?.message ??
      (parsed?.message as unknown) ??
      normalizedBody ??
      `HTTP ${response.status}`;
    throw new DeepResearchError(
      `${provider} request failed: ${String(providerMessage)}`,
      "PROVIDER_REQUEST_FAILED",
      response.status
    );
  }

  return parsed ?? {};
}

function extractOpenAiText(payload: JsonRecord): string {
  const outputText = payload.output_text;
  if (typeof outputText === "string" && outputText.trim().length > 0) {
    return outputText;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const fragments: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as JsonRecord).content) ? ((item as JsonRecord).content as unknown[]) : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as JsonRecord;
      const text = record.text;
      if (typeof text === "string" && text.trim().length > 0) {
        fragments.push(text.trim());
      }
    }
  }

  return ensureStringContent(fragments.join("\n\n"));
}

function extractAnthropicText(payload: JsonRecord): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const fragments = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as JsonRecord).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter((text) => text.length > 0);
  return ensureStringContent(fragments.join("\n\n"));
}

function extractGeminiText(payload: JsonRecord): string {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const fragments: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = (candidate as JsonRecord).content;
    if (!content || typeof content !== "object") continue;
    const parts = Array.isArray((content as JsonRecord).parts) ? ((content as JsonRecord).parts as unknown[]) : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const text = (part as JsonRecord).text;
      if (typeof text === "string" && text.trim().length > 0) {
        fragments.push(text.trim());
      }
    }
  }

  return ensureStringContent(fragments.join("\n\n"));
}

function buildAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  const hasDomException = typeof DOMException !== "undefined";
  return (
    (hasDomException && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function extractGeminiInteractionText(payload: JsonRecord): string {
  const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
  const fragments = outputs
    .map((output) => {
      if (!output || typeof output !== "object") return "";
      const text = (output as JsonRecord).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter((text) => text.length > 0);
  return ensureStringContent(fragments.join("\n\n"));
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(buildAbortError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(buildAbortError());
    };

    signal.addEventListener("abort", onAbort);
  });
}

async function runOpenAiResearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const prompt = promptForResearch(query);
  const attempt = async (activeModel: string): Promise<string> => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: activeModel,
        input: prompt
      })
    });
    const payload = await readJsonResponse(response, "openai");
    return extractOpenAiText(payload);
  };

  try {
    return await attempt(model);
  } catch (error) {
    if (
      error instanceof DeepResearchError &&
      (error.status === 400 || error.status === 404) &&
      model !== OPENAI_FALLBACK_MODEL
    ) {
      return attempt(OPENAI_FALLBACK_MODEL);
    }
    throw error;
  }
}

async function runAnthropicResearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: promptForResearch(query)
        }
      ]
    })
  });

  const payload = await readJsonResponse(response, "anthropic");
  return extractAnthropicText(payload);
}

async function runGeminiResearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  if (model.startsWith(GEMINI_DEEP_RESEARCH_AGENT_PREFIX)) {
    const createResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          agent: model,
          input: query,
          background: true
        })
      }
    );
    const created = await readJsonResponse(createResponse, "gemini");
    const interactionId = typeof created.id === "string" ? created.id : undefined;
    if (!interactionId) {
      throw new DeepResearchError("Gemini deep research interaction id is missing", "PROVIDER_REQUEST_FAILED", 502);
    }

    let status = typeof created.status === "string" ? created.status : "running";
    let current = created;

    while (status === "running" || status === "queued" || status === "in_progress") {
      await delayWithAbort(GEMINI_INTERACTION_POLL_MS, signal);
      const statusResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}?key=${encodeURIComponent(apiKey)}`,
        {
          method: "GET",
          signal,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
      current = await readJsonResponse(statusResponse, "gemini");
      status = typeof current.status === "string" ? current.status : "running";
    }

    if (status === "completed") {
      return extractGeminiInteractionText(current);
    }

    const errorMessage =
      (current.error as { message?: unknown } | undefined)?.message ??
      current.message ??
      `Gemini deep research finished with status '${status}'`;
    throw new DeepResearchError(String(errorMessage), "PROVIDER_REQUEST_FAILED", 502);
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: promptForResearch(query) }]
        }
      ],
      generationConfig: {
        temperature: 0.2
      }
    })
  });

  const payload = await readJsonResponse(response, "gemini");
  return extractGeminiText(payload);
}

export function resolveProviderModel(provider: DeepResearchProvider, speed: DeepResearchSpeed): string {
  return MODEL_MAP[provider][speed];
}

export async function runDeepResearchProvider(input: {
  provider: DeepResearchProvider;
  speed: DeepResearchSpeed;
  model: string;
  query: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<DeepResearchProviderResult> {
  const { provider, speed: _speed, model, query, apiKey, signal } = input;
  try {
    let content: string;
    if (provider === "openai") {
      content = await runOpenAiResearch(query, model, apiKey, signal);
    } else if (provider === "anthropic") {
      content = await runAnthropicResearch(query, model, apiKey, signal);
    } else {
      content = await runGeminiResearch(query, model, apiKey, signal);
    }

    return {
      content,
      provider,
      model
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof DeepResearchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unexpected provider error";
    throw new DeepResearchError(message, "PROVIDER_EXECUTION_FAILED", 502);
  }
}
