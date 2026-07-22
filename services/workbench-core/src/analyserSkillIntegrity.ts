import { createHash } from "node:crypto";
import { AGENT_SKILLS_PROJECT_ID, extractSkillKeys, skillKeyFromPath } from "./analyserSkillCatalog.js";
import type { analyserClient, artifactsClient } from "./internalClients.js";

export interface SkillIntegrityDeps {
  treeList: typeof artifactsClient.treeList;
  listRoutines: typeof analyserClient.listRoutines;
  listSkillSnapshots: typeof analyserClient.listSkillSnapshots;
  setRoutineSkillFlags: typeof analyserClient.setRoutineSkillFlags;
  createProposal: typeof analyserClient.createProposal;
}

export interface SkillIntegritySummary {
  checkedRoutines: number;
  missing: string[];
  drifted: string[];
  proposalsCreated: number;
}

// This MUST stay in sync with services/analyser/src/stores/skillSnapshots.ts; parity tests guard the contract.
export function normalizeSkillBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
}

export function hashSkillBody(body: string): string {
  return createHash("sha256").update(normalizeSkillBody(body), "utf8").digest("hex");
}

function itemsFrom(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const items = (result as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

function stringProperty(item: unknown, property: string): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  try {
    const value = (item as Record<string, unknown>)[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function runSkillIntegrityCheck(
  token: string,
  deps: SkillIntegrityDeps
): Promise<SkillIntegritySummary> {
  const treeResult = await deps.treeList(token, {
    projectId: AGENT_SKILLS_PROJECT_ID,
    pathPrefix: "skills/",
    kinds: ["note"],
    includeContent: true,
    limit: 1000
  });
  const items = itemsFrom(treeResult);
  const catalogKeys = new Set(extractSkillKeys(items));
  const canonicalBody = new Map<string, string>();

  for (const item of items) {
    const path = stringProperty(item, "path");
    const contentMarkdown = stringProperty(item, "contentMarkdown");
    if (path === undefined || contentMarkdown === undefined) continue;
    const skillKey = skillKeyFromPath(path);
    if (!skillKey) continue;
    canonicalBody.set(skillKey, contentMarkdown);
  }

  const routineResult = await deps.listRoutines(token);
  const routines = itemsFrom(routineResult);
  const routineSkillKeys = new Set<string>();
  for (const routine of routines) {
    const skillKey = stringProperty(routine, "skillKey");
    if (skillKey) routineSkillKeys.add(skillKey);
  }

  const snapshotResult = await deps.listSkillSnapshots(token);
  const snapshots = new Map<string, string>();
  for (const snapshot of itemsFrom(snapshotResult)) {
    const skillKey = stringProperty(snapshot, "skillKey");
    const contentHash = stringProperty(snapshot, "contentHash");
    if (skillKey && contentHash) snapshots.set(skillKey, contentHash);
  }

  const missing = [...routineSkillKeys]
    .filter((skillKey) => !catalogKeys.has(skillKey))
    .sort((left, right) => left.localeCompare(right));
  const drift = [...canonicalBody]
    .flatMap(([skillKey, body]) => {
      const snapshotHash = snapshots.get(skillKey);
      if (snapshotHash === undefined) return [];
      const canonicalHash = hashSkillBody(body);
      return canonicalHash === snapshotHash ? [] : [{ skillKey, canonicalHash }];
    })
    .sort((left, right) => left.skillKey.localeCompare(right.skillKey));

  await deps.setRoutineSkillFlags(token, { missingSkillKeys: missing });

  let proposalsCreated = 0;
  for (const { skillKey, canonicalHash } of drift) {
    const proposalResult = await deps.createProposal(token, {
      kind: "skill_drift",
      title: `Skill drift detected: ${skillKey}`,
      bodyMarkdown: `## Skill drift\n\n- Skill key: \`${skillKey}\`\n- The canonical AgentSkills body changed from the stored Analyser snapshot.\n\nReview the change and re-snapshot the skill if it is accepted.`,
      dedupeKey: `skill-drift:${skillKey}:${canonicalHash}`
    });
    if (proposalResult && typeof proposalResult === "object"
      && (proposalResult as { created?: unknown }).created === true) {
      proposalsCreated += 1;
    }
  }

  return {
    checkedRoutines: routines.length,
    missing,
    drifted: drift.map(({ skillKey }) => skillKey),
    proposalsCreated
  };
}
