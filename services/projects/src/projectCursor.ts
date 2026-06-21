export type CursorPayload = { t: string; id: string };

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export function parseCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new InvalidCursorError();
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<CursorPayload> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidCursorError();
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !Object.hasOwn(parsed, "t") || !Object.hasOwn(parsed, "id")) {
      throw new InvalidCursorError();
    }
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string" || !parsed.t || !parsed.id) {
      throw new InvalidCursorError();
    }
    if (!Number.isFinite(Date.parse(parsed.t))) throw new InvalidCursorError();
    if (new Date(parsed.t).toISOString() !== parsed.t) throw new InvalidCursorError();
    return { t: parsed.t, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}

export function toCursor(timestamp: string | Date, id: string): string {
  const t = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return Buffer.from(JSON.stringify({ t, id }), "utf8").toString("base64url");
}
