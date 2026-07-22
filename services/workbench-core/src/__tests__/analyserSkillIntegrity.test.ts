import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_SKILLS_PROJECT_ID } from "../analyserSkillCatalog.js";
import {
  hashSkillBody,
  normalizeSkillBody,
  runSkillIntegrityCheck,
  type SkillIntegrityDeps
} from "../analyserSkillIntegrity.js";

describe("Analyser skill integrity", () => {
  it("reconciles missing routines and creates one deduplicated drift proposal", async () => {
    const flagCalls: Array<{ token: string; payload: unknown }> = [];
    const proposalCalls: Array<{ token: string; payload: Record<string, unknown> }> = [];
    let treeOptions: unknown;
    const deps: SkillIntegrityDeps = {
      treeList: async (_token, options) => {
        treeOptions = options;
        return [
          { path: "skills/skill-ok/SKILL.md", contentMarkdown: "A" },
          { path: "skills/skill-drift/skill.MD", contentMarkdown: "CHANGED" },
          { path: "skills/malformed/SKILL.md", contentMarkdown: 42 },
          null
        ];
      },
      listRoutines: async () => ({ items: [
        { skillKey: "skill-ok" },
        { skillKey: "skill-drift" },
        { skillKey: "skill-gone" }
      ] }),
      listSkillSnapshots: async () => ({ items: [
        { skillKey: "skill-ok", contentHash: hashSkillBody("A") },
        { skillKey: "skill-drift", contentHash: hashSkillBody("OLD") }
      ] }),
      setRoutineSkillFlags: async (token, payload) => {
        flagCalls.push({ token, payload });
        return {};
      },
      createProposal: async (token, payload) => {
        proposalCalls.push({ token, payload: payload as Record<string, unknown> });
        return { created: true };
      }
    };

    const result = await runSkillIntegrityCheck("user-token", deps);
    const canonicalHash = hashSkillBody("CHANGED");

    assert.deepEqual(treeOptions, {
      projectId: AGENT_SKILLS_PROJECT_ID,
      pathPrefix: "skills/",
      kinds: ["note"],
      includeContent: true,
      limit: 1000
    });
    assert.deepEqual(flagCalls, [{ token: "user-token", payload: { missingSkillKeys: ["skill-gone"] } }]);
    assert.equal(proposalCalls.length, 1);
    assert.equal(proposalCalls[0].token, "user-token");
    assert.equal(proposalCalls[0].payload.kind, "skill_drift");
    assert.equal(proposalCalls[0].payload.title, "Skill drift detected: skill-drift");
    assert.equal(proposalCalls[0].payload.dedupeKey, `skill-drift:skill-drift:${canonicalHash}`);
    assert.deepEqual(result, {
      checkedRoutines: 3,
      missing: ["skill-gone"],
      drifted: ["skill-drift"],
      proposalsCreated: 1
    });
  });

  it("keeps newline normalization and hashing compatible with the Analyser snapshot rule", () => {
    assert.equal(normalizeSkillBody("a\r\nb\n"), normalizeSkillBody("a\nb"));
    assert.equal(normalizeSkillBody("a\r\nb\n"), "a\nb");
    assert.equal(hashSkillBody("a\r\nb\n"), hashSkillBody("a\nb"));
  });
});
