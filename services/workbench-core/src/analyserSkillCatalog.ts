export const AGENT_SKILLS_PROJECT_ID = process.env.ANALYSER_SKILLS_PROJECT_ID?.trim()
  || "936c62d5-1d5a-42af-979b-696c3e4d0526";

const RESERVED_SKILL_KEY_SEGMENTS = new Set([".", ".."]) as ReadonlySet<string>;

export function extractSkillKeys(items: unknown[]): string[] {
  const keys = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== "string") continue;

    const match = /^(?:\.\/|\/)?skills\/([^/]+)(?:\/.*)?$/.exec(path);
    const key = match?.[1]?.trim();
    if (!key || RESERVED_SKILL_KEY_SEGMENTS.has(key)) continue;
    keys.add(key);
  }

  return [...keys].sort((left, right) => left.localeCompare(right));
}

export async function fetchSkillCatalog(
  token: string,
  deps: {
    treeList: (
      token: string,
      opts: { projectId?: string; pathPrefix?: string; limit?: number }
    ) => Promise<unknown[]>;
  }
): Promise<{ skills: string[] }> {
  const result: unknown = await deps.treeList(token, {
    projectId: AGENT_SKILLS_PROJECT_ID,
    pathPrefix: "skills/",
    limit: 1000
  });
  const items = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)
      ? (result as { items: unknown[] }).items
      : [];
  return { skills: extractSkillKeys(items) };
}
