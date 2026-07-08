import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

process.env.ARTIFACTS_DB_HOST ||= "127.0.0.1";
process.env.ARTIFACTS_DB_PORT ||= "5432";
process.env.ARTIFACTS_DB_NAME ||= "workbench-artifacts-test";
process.env.ARTIFACTS_DB_USER ||= "workbench-artifacts-test";
process.env.ARTIFACTS_DB_PASSWORD ||= "workbench-artifacts-test";

const [{ artifactItemsStoreTestHooks }, db] = await Promise.all([
  import("../artifactItemsStore.js"),
  import("../db.js")
]);

const runDbTests = process.env.RUN_ARTIFACTS_DB_TESTS === "1";

after(async () => {
  if (runDbTests) {
    await db.getArtifactsPool().end();
  }
});

describe("artifact item project context", () => {
  it("does not use projectId as the projectName fallback", () => {
    const projectId = "123e4567-e89b-12d3-a456-426614174000";

    assert.deepEqual(artifactItemsStoreTestHooks.resolveProjectContext(projectId, undefined), {
      projectId,
      projectName: undefined
    });
    assert.deepEqual(artifactItemsStoreTestHooks.resolveProjectContext(projectId, "  Display Name  "), {
      projectId,
      projectName: "Display Name"
    });
  });

  it("keeps the legacy default Project fallback branch", () => {
    assert.deepEqual(artifactItemsStoreTestHooks.resolveProjectContext(undefined, undefined), {
      projectId: "default",
      projectName: "default"
    });
  });

  it("cleanup nulls artifact item rows where project_name equals project_id", { skip: !runDbTests }, async () => {
    await db.ensureArtifactsSchema();
    const pool = db.getArtifactsPool();
    const id = `test-${randomUUID()}`;
    const owner = `owner-${randomUUID()}`;
    const projectId = "123e4567-e89b-12d3-a456-426614174001";

    try {
      await pool.query(
        `
          INSERT INTO artifact_items (
            id,
            owner_username,
            project_id,
            project_name,
            kind,
            title,
            path,
            parent_path,
            version
          )
          VALUES ($1, $2, $3, $3, 'note', 'Test', $4, '', 1)
        `,
        [id, owner, projectId, `${id}.md`]
      );

      await db.cleanupArtifactItemProjectNameFallbacks();
      const result = await pool.query<{ project_name: string | null }>(
        "SELECT project_name FROM artifact_items WHERE id = $1",
        [id]
      );

      assert.equal(result.rows[0]?.project_name, null);
    } finally {
      await pool.query("DELETE FROM artifact_items WHERE id = $1", [id]).catch(() => undefined);
    }
  });
});

describe("artifact note section updates", () => {
  it("keeps the next heading separated when replacement text has no trailing newline", () => {
    const result = artifactItemsStoreTestHooks.applyNoteSectionUpdate("# First\nold\n# Next\nnext", {
      heading: "First",
      contentMarkdown: "new"
    });

    assert.equal(result, "# First\n\nnew\n\n# Next\nnext");
  });

  it("does not grow excessive blank lines around appended content", () => {
    const result = artifactItemsStoreTestHooks.applyNoteSectionUpdate("# First\n\nold\n\n# Next\nnext", {
      heading: "First",
      mode: "appendBody",
      contentMarkdown: "\n\nnew\n\n\nextra\n\n"
    });

    assert.equal(result, "# First\n\nold\n\nnew\n\nextra\n\n# Next\nnext");
    assert.doesNotMatch(result, /\n{3,}/);
  });

  it("leaves an already-normal replacement case unchanged", () => {
    const content = "# First\n\nold\n\n# Next\nnext";
    const result = artifactItemsStoreTestHooks.applyNoteSectionUpdate(content, {
      heading: "First",
      contentMarkdown: "old"
    });

    assert.equal(result, content);
  });
});
