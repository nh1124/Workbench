export const AGENT_SKILLS_PROJECT_ID = process.env.ANALYSER_SKILLS_PROJECT_ID?.trim()
  || "936c62d5-1d5a-42af-979b-696c3e4d0526";

// Canonical skills are markdown notes stored under skills/ with arbitrary folder
// nesting (e.g. skills/engineering/workbench-operations/workbench-analyser-cycle.md).
// The skill key is the file basename without ".md", which is what routine.skillKey
// holds (e.g. workbench-analyser-cycle). Index files (…/00_INDEX.md) are not skills.
export function skillKeyFromPath(path: string): string | undefined {
  const match = /^(?:\.\/|\/)?skills\/(?:.*\/)?([^/]+)\.md$/i.exec(path.trim());
  const stem = match?.[1]?.trim();
  if (!stem) return undefined;
  if (/^\d+_index$/i.test(stem) || /^index$/i.test(stem)) return undefined;
  return stem;
}

export function extractSkillKeys(items: unknown[]): string[] {
  const keys = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    if (kind !== undefined && kind !== "note") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== "string") continue;

    const key = skillKeyFromPath(path);
    if (key) keys.add(key);
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
