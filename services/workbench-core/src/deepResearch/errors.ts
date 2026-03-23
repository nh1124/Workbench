export class DeepResearchError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "DEEP_RESEARCH_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function ensureStringContent(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new DeepResearchError("Provider returned empty content", "EMPTY_RESULT", 502);
}
