import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_SKILLS_PROJECT_ID,
  extractSkillKeys,
  fetchSkillCatalog
} from "../analyserSkillCatalog.js";

const skillItems = [
  { path: "skills/workbench-analyser-cycle/SKILL.md" },
  { path: "skills/workbench-maintenance/SKILL.md" },
  { path: "skills/workbench-analyser-cycle/extra.md" },
  { path: "skills/" },
  { path: "README.md" },
  { path: 42 },
  null
];

const expectedSkills = ["workbench-analyser-cycle", "workbench-maintenance"];

describe("Analyser skill catalog", () => {
  it("extracts distinct sorted skill keys and ignores malformed or unrelated paths", () => {
    assert.deepEqual(extractSkillKeys(skillItems), expectedSkills);
  });

  it("fetches the canonical AgentSkills tree and extracts its skill keys", async () => {
    let receivedToken: string | undefined;
    let receivedOptions: unknown;
    const result = await fetchSkillCatalog("user-token", {
      treeList: async (token, options) => {
        receivedToken = token;
        receivedOptions = options;
        return skillItems;
      }
    });

    assert.deepEqual(result, { skills: expectedSkills });
    assert.equal(receivedToken, "user-token");
    assert.deepEqual(receivedOptions, {
      projectId: AGENT_SKILLS_PROJECT_ID,
      pathPrefix: "skills/",
      limit: 1000
    });
  });

  it("accepts a paged tree response", async () => {
    const result = await fetchSkillCatalog("user-token", {
      treeList: async () => ({ items: skillItems }) as unknown as unknown[]
    });

    assert.deepEqual(result, { skills: expectedSkills });
  });

  it("does not catch tree lookup failures", async () => {
    await assert.rejects(
      fetchSkillCatalog("user-token", {
        treeList: async () => {
          throw new Error("artifacts unavailable");
        }
      }),
      /artifacts unavailable/
    );
  });
});
