import assert from "node:assert/strict";
import test from "node:test";

const runIntegration = process.env.RUN_PROJECTS_DB_TESTS === "1";

function configureEnvironment(): void {
  const defaults: Record<string, string> = {
    PROJECTS_DB_HOST: "127.0.0.1", PROJECTS_DB_PORT: "5546", PROJECTS_DB_NAME: "projects_db",
    PROJECTS_DB_USER: "projects_user", PROJECTS_DB_PASSWORD: "projects_pass",
    PROJECTS_SERVICE_HOST: "127.0.0.1", PROJECTS_SERVICE_PORT: "4104",
    JWT_SECRET: "test-projects-jwt-secret", JWT_ISSUER: "workbench-core", INTERNAL_API_KEY: "test-internal-key"
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
}

test("project context stores preserve owner isolation, idempotence and relation integrity", { skip: !runIntegration }, async () => {
  configureEnvironment();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerA = `integration-a-${suffix}`;
  const ownerB = `integration-b-${suffix}`;
  const [{ getProjectsPool, ensureProjectsSchema }, projectStore, briefStore, memoryStore, indexStore, linksStore, relationStore, errors] = await Promise.all([
    import("../db.js"), import("../store.js"), import("../projectBriefStore.js"), import("../projectMemoryStore.js"),
    import("../projectIndexStore.js"), import("../projectLinksStore.js"), import("../projectRelationsStore.js"), import("../projectStoreUtils.js")
  ]);
  await ensureProjectsSchema();
  const projectA = await projectStore.createProject({ name: "A" }, ownerA);
  const projectA2 = await projectStore.createProject({ name: "A2" }, ownerA);
  const projectB = await projectStore.createProject({ name: "B" }, ownerB);
  try {
    const brief = await briefStore.updateProjectBrief(projectA.id, {
      contentMarkdown: "rules", expectedVersion: 0, updatedByKind: "user"
    }, ownerA);
    assert.equal(brief?.version, 1);
    assert.equal(await briefStore.getProjectBrief(projectA.id, ownerB), undefined);
    await assert.rejects(() => briefStore.updateProjectBrief(projectA.id, {
      contentMarkdown: "stale", expectedVersion: 0, updatedByKind: "agent"
    }, ownerA), errors.VersionConflictError);

    const firstMemory = await memoryStore.appendProjectMemory(projectA.id, {
      kind: "decision", bodyMarkdown: "first", authority: "user_confirmed", createdByKind: "user"
    }, ownerA);
    assert.ok(firstMemory);
    await memoryStore.appendProjectMemory(projectA.id, {
      kind: "decision", bodyMarkdown: "second", authority: "user_confirmed", createdByKind: "user",
      supersedesId: firstMemory.id
    }, ownerA);
    const memories = await memoryStore.listProjectMemories(projectA.id, ownerA);
    assert.deepEqual(memories?.items.map((item) => item.bodyMarkdown), ["second"]);
    assert.equal(await memoryStore.listProjectMemories(projectA.id, ownerB), undefined);

    const indexInput = {
      sourceService: "artifacts", resourceType: "note", resourceId: `artifact-${suffix}`,
      associationKind: "primary" as const, title: "Artifact", summaryText: "summary",
      sourceUpdatedAt: "2026-06-20T00:00:00.000Z"
    };
    const index1 = await indexStore.upsertProjectIndexEntry(projectA.id, indexInput, ownerA);
    const index2 = await indexStore.upsertProjectIndexEntry(projectA.id, { ...indexInput, title: "Updated" }, ownerA);
    assert.equal(index1?.id, index2?.id);
    assert.equal((await indexStore.searchProjectIndex(projectA.id, ownerA))?.items.length, 1);
    await indexStore.tombstoneProjectIndexEntry(projectA.id, indexInput, ownerA);
    assert.equal((await indexStore.searchProjectIndex(projectA.id, ownerA))?.items.length, 0);

    const membershipInput = {
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId,
      relationType: "secondary_membership"
    };
    const link1 = await projectStore.linkResourceToProject(projectA2.id, membershipInput, ownerA);
    const link2 = await projectStore.linkResourceToProject(projectA2.id, membershipInput, ownerA);
    assert.equal(link1?.id, link2?.id);
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId,
      relationType: "secondary_membership"
    }, ownerA)).items.length, 1);
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId
    }, ownerB)).items.length, 0);

    await assert.rejects(() => relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectA.id, relationType: "related", createdByKind: "user"
    }, ownerA), errors.InvalidRelationError);
    assert.equal(await relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectB.id, relationType: "related", createdByKind: "user"
    }, ownerA), undefined);
    await relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectA2.id, relationType: "related", directionality: "bidirectional", createdByKind: "user"
    }, ownerA);
    await assert.rejects(() => relationStore.createProjectRelation(projectA2.id, {
      targetProjectId: projectA.id, relationType: "related", directionality: "bidirectional", createdByKind: "user"
    }, ownerA), errors.DuplicateRelationError);

    await projectStore.deleteProject(projectA2.id, ownerA);
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId
    }, ownerA)).items.length, 0);
    assert.equal((await relationStore.listProjectRelations(projectA.id, ownerA))?.items.length, 0);
  } finally {
    await getProjectsPool().query(`DELETE FROM projects WHERE owner_account_id = ANY($1::text[])`, [[ownerA, ownerB]]);
    await getProjectsPool().end();
  }
});
