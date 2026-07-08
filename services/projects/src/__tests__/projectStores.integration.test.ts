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
  const [{ getProjectsPool, ensureProjectsSchema }, projectStore, briefStore, memoryStore, indexStore, linksStore, relationStore, snapshotStore, contextStore, errors] = await Promise.all([
    import("../db.js"), import("../store.js"), import("../projectBriefStore.js"), import("../projectMemoryStore.js"),
    import("../projectIndexStore.js"), import("../projectLinksStore.js"), import("../projectRelationsStore.js"),
    import("../projectContextSnapshotsStore.js"), import("../projectContextStore.js"), import("../projectStoreUtils.js")
  ]);
  await Promise.all([ensureProjectsSchema(), ensureProjectsSchema()]);
  await ensureProjectsSchema();
  const schemaObjects = await getProjectsPool().query<{ briefs: string | null; memories: string | null; index_entries: string | null; relations: string | null }>(
    `SELECT to_regclass('project_briefs')::text AS briefs,
            to_regclass('project_memory_entries')::text AS memories,
            to_regclass('project_index_entries')::text AS index_entries,
            to_regclass('project_relations')::text AS relations`
  );
  assert.deepEqual(schemaObjects.rows[0], {
    briefs: "project_briefs",
    memories: "project_memory_entries",
    index_entries: "project_index_entries",
    relations: "project_relations"
  });
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
    const secondMemory = await memoryStore.appendProjectMemory(projectA.id, {
      kind: "decision", bodyMarkdown: "second", authority: "user_confirmed", createdByKind: "user",
      supersedesId: firstMemory.id
    }, ownerA);
    assert.ok(secondMemory);
    const memories = await memoryStore.listProjectMemories(projectA.id, ownerA);
    assert.deepEqual(memories?.items.map((item) => item.bodyMarkdown), ["second"]);
    assert.equal(await memoryStore.listProjectMemories(projectA.id, ownerB), undefined);
    assert.equal(await memoryStore.updateProjectMemory(secondMemory.id, { status: "archived" }, ownerB), undefined);
    const archivedMemory = await memoryStore.updateProjectMemory(secondMemory.id, { status: "archived" }, ownerA);
    assert.equal(archivedMemory?.status, "archived");
    assert.deepEqual((await memoryStore.listProjectMemories(projectA.id, ownerA))?.items, []);
    assert.deepEqual(
      (await memoryStore.listProjectMemories(projectA.id, ownerA, { status: "archived" }))?.items.map((item) => item.id),
      [secondMemory.id]
    );

    const overlongContent = `${"a".repeat(20_000)}tail-after-bound`;
    const indexInput = {
      sourceService: "artifacts", resourceType: "note", resourceId: `artifact-${suffix}`,
      associationKind: "primary" as const, title: "Artifact", summaryText: "summary",
      contentText: overlongContent,
      sourceUpdatedAt: "2026-06-20T00:00:00.000Z"
    };
    const index1 = await indexStore.upsertProjectIndexEntry(projectA.id, indexInput, ownerA);
    const index2 = await indexStore.upsertProjectIndexEntry(projectA.id, { ...indexInput, title: "Updated" }, ownerA);
    assert.equal(index1?.id, index2?.id);
    assert.ok(index2);
    assert.equal(Object.hasOwn(index2, "contentText"), false);
    const storedContent = await getProjectsPool().query<{ content_text: string | null }>(
      `SELECT content_text FROM project_index_entries WHERE id = $1`,
      [index2.id]
    );
    assert.equal(storedContent.rows[0]?.content_text?.length, 20_000);
    assert.equal(storedContent.rows[0]?.content_text?.includes("tail-after-bound"), false);
    assert.equal((await indexStore.searchProjectIndex(projectA.id, ownerA))?.items.length, 1);
    await indexStore.tombstoneProjectIndexEntry(projectA.id, indexInput, ownerA);
    assert.equal((await indexStore.searchProjectIndex(projectA.id, ownerA))?.items.length, 0);
    const contentOnlyToken = `deepcontent${suffix.replace(/[^a-z0-9]/gi, "")}`;
    const bulkEntries = await indexStore.bulkUpsertProjectIndexEntries(projectA.id, [
      { ...indexInput, title: "Bulk rebuilt Artifact", contentText: contentOnlyToken },
      {
        ...indexInput,
        resourceType: "file",
        resourceId: `file-${suffix}`,
        title: "Bulk file",
        contentText: contentOnlyToken
      },
      {
        ...indexInput,
        resourceType: "note",
        resourceId: `low-${suffix}`,
        title: "Bulk low",
        contentText: contentOnlyToken
      }
    ], ownerA);
    assert.equal(bulkEntries?.length, 3);
    assert.equal(JSON.stringify(bulkEntries).includes("contentText"), false);
    assert.equal(await indexStore.bulkUpsertProjectIndexEntries(projectA.id, [indexInput], ownerB), undefined);
    assert.equal((await indexStore.searchProjectIndex(projectA.id, ownerA))?.items.length, 3);
    assert.equal(await indexStore.searchProjectIndex(projectA.id, ownerB), undefined);
    const contentSearch = await indexStore.searchProjectIndex(projectA.id, ownerA, { query: contentOnlyToken });
    assert.equal(contentSearch?.items.length, 3);
    assert.equal(JSON.stringify(contentSearch).includes("contentText"), false);
    assert.deepEqual(contentSearch?.appliedQuery?.fields, ["path", "title", "summary", "metadata", "content"]);
    const contextSearch = await contextStore.getProjectContext(projectA.id, ownerA, {
      query: contentOnlyToken,
      include: ["index"],
      indexLimit: 10
    });
    assert.equal(contextSearch?.indexEntries?.length, 3);
    assert.equal(JSON.stringify(contextSearch).includes("contentText"), false);
    const anySearch = await indexStore.searchProjectIndex(projectA.id, ownerA, { query: "Ｂｕｌｋ　file" });
    assert.deepEqual(anySearch?.appliedQuery, {
      tokens: ["Bulk", "file"],
      mode: "any",
      fields: ["path", "title", "summary", "metadata", "content"]
    });
    assert.equal(anySearch?.items.length, 3);
    assert.equal(anySearch?.items[0]?.resourceId, `file-${suffix}`);
    assert.deepEqual(new Set(anySearch?.items.map((item) => item.resourceId)), new Set([indexInput.resourceId, `file-${suffix}`, `low-${suffix}`]));
    const matchedByResourceId = new Map(anySearch?.items.map((item) => [item.resourceId, item.matchedTokens]));
    assert.equal(matchedByResourceId.get(indexInput.resourceId), 1);
    assert.equal(matchedByResourceId.get(`file-${suffix}`), 2);
    assert.equal(matchedByResourceId.get(`low-${suffix}`), 1);
    const scoredPage1 = await indexStore.searchProjectIndex(projectA.id, ownerA, { query: "Bulk file", limit: 1 });
    assert.equal(scoredPage1?.items[0]?.resourceId, `file-${suffix}`);
    const scoredCursor1 = scoredPage1?.nextCursor;
    assert.ok(scoredCursor1);
    assert.throws(() => errors.parseCursor(scoredCursor1), errors.InvalidCursorError);
    const scoredPage2 = await indexStore.searchProjectIndex(projectA.id, ownerA, {
      query: "Bulk file",
      limit: 1,
      cursor: scoredCursor1
    });
    const scoredCursor2 = scoredPage2?.nextCursor;
    assert.ok(scoredCursor2);
    const scoredPage3 = await indexStore.searchProjectIndex(projectA.id, ownerA, {
      query: "Bulk file",
      limit: 1,
      cursor: scoredCursor2
    });
    const scoredPagedIds = [scoredPage1, scoredPage2, scoredPage3].flatMap((page) =>
      page?.items.map((item) => item.resourceId) ?? []
    );
    assert.equal(new Set(scoredPagedIds).size, 3);
    assert.deepEqual(scoredPagedIds.sort(), [indexInput.resourceId, `file-${suffix}`, `low-${suffix}`].sort());
    await assert.rejects(
      () => indexStore.searchProjectIndex(projectA.id, ownerA, {
        query: "Bulk",
        cursor: errors.toCursor("2026-06-20T00:00:00.000Z", "legacy-id")
      }),
      errors.InvalidCursorError
    );
    const unfilteredPage1 = await indexStore.searchProjectIndex(projectA.id, ownerA, { limit: 1 });
    const unfilteredCursor1 = unfilteredPage1?.nextCursor;
    assert.ok(unfilteredCursor1);
    assert.doesNotThrow(() => errors.parseCursor(unfilteredCursor1));
    const unfilteredPage2 = await indexStore.searchProjectIndex(projectA.id, ownerA, {
      limit: 1,
      cursor: unfilteredCursor1
    });
    assert.notEqual(unfilteredPage1?.items[0]?.id, unfilteredPage2?.items[0]?.id);
    const allSearch = await indexStore.searchProjectIndex(projectA.id, ownerA, { query: "Ｂｕｌｋ　file", mode: "all" });
    assert.deepEqual(allSearch?.appliedQuery, {
      tokens: ["Bulk", "file"],
      mode: "all",
      fields: ["path", "title", "summary", "metadata", "content"]
    });
    assert.deepEqual(allSearch?.items.map((item) => item.resourceId), [`file-${suffix}`]);

    const membershipInput = {
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId,
      relationType: "secondary_membership"
    };
    const link1 = await projectStore.linkResourceToProject(projectA2.id, membershipInput, ownerA);
    const link2 = await projectStore.linkResourceToProject(projectA2.id, membershipInput, ownerA);
    assert.ok(link1);
    assert.equal(link1?.id, link2?.id);
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId,
      relationType: "secondary_membership"
    }, ownerA)).items.length, 1);
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId
    }, ownerB)).items.length, 0);

    await briefStore.updateProjectBrief(projectA2.id, {
      contentMarkdown: "delete cascade fixture", expectedVersion: 0, updatedByKind: "user"
    }, ownerA);
    await memoryStore.appendProjectMemory(projectA2.id, {
      kind: "observation", bodyMarkdown: "delete cascade memory", authority: "agent_observed", createdByKind: "agent"
    }, ownerA);
    await indexStore.upsertProjectIndexEntry(projectA2.id, {
      ...indexInput,
      associationKind: "secondary",
      associationId: link1.id,
      title: "Delete cascade index"
    }, ownerA);

    await assert.rejects(() => relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectA.id, relationType: "related", createdByKind: "user"
    }, ownerA), errors.InvalidRelationError);
    assert.equal(await relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectB.id, relationType: "related", createdByKind: "user"
    }, ownerA), undefined);
    const editableRelation = await relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectA2.id, relationType: "related", directionality: "bidirectional", createdByKind: "user"
    }, ownerA);
    assert.ok(editableRelation);
    assert.equal((await relationStore.getProjectRelation(editableRelation.id, ownerA))?.sourceProjectId, projectA.id);
    assert.equal(await relationStore.getProjectRelation(editableRelation.id, ownerB), undefined);
    await assert.rejects(() => relationStore.createProjectRelation(projectA2.id, {
      targetProjectId: projectA.id, relationType: "related", directionality: "bidirectional", createdByKind: "user"
    }, ownerA), errors.DuplicateRelationError);
    assert.equal(await relationStore.listProjectRelations(projectA.id, ownerB), undefined);
    assert.equal(await relationStore.updateProjectRelation(editableRelation.id, {
      note: "not owner", expectedVersion: editableRelation.version
    }, ownerB), undefined);
    const updatedRelation = await relationStore.updateProjectRelation(editableRelation.id, {
      note: "updated relation", strength: 0.75, expectedVersion: editableRelation.version
    }, ownerA);
    assert.equal(updatedRelation?.version, editableRelation.version + 1);
    assert.equal(updatedRelation?.note, "updated relation");
    assert.equal(updatedRelation?.strength, 0.75);
    assert.equal(await relationStore.deleteProjectRelation(editableRelation.id, ownerB), false);
    assert.equal(await relationStore.deleteProjectRelation(editableRelation.id, ownerA), true);
    await relationStore.createProjectRelation(projectA.id, {
      targetProjectId: projectA2.id, relationType: "supports", createdByKind: "user"
    }, ownerA);

    const syncSnapshot = await snapshotStore.getProjectSyncContextSnapshot(projectA.id, ownerA);
    assert.equal(syncSnapshot?.complete, true);
    assert.deepEqual(syncSnapshot?.counts, { memories: 1, relations: 1 });
    assert.deepEqual(syncSnapshot?.memories.map((item) => item.bodyMarkdown), ["second"]);
    assert.equal(await snapshotStore.getProjectSyncContextSnapshot(projectA.id, ownerB), undefined);

    const exportSnapshot = await snapshotStore.getProjectContextExportSnapshot(projectA.id, ownerA);
    assert.equal(exportSnapshot?.complete, true);
    assert.equal(exportSnapshot?.counts.memories, 2);
    assert.equal(exportSnapshot?.counts.relations, 1);
    assert.deepEqual(exportSnapshot?.memories.map((item) => item.bodyMarkdown), ["first", "second"]);
    assert.equal(await snapshotStore.getProjectContextExportSnapshot(projectA.id, ownerB), undefined);

    const ownedRowsBeforeDelete = await getProjectsPool().query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*)::text FROM project_links WHERE project_id = $1) AS links,
        (SELECT COUNT(*)::text FROM project_briefs WHERE project_id = $1) AS briefs,
        (SELECT COUNT(*)::text FROM project_memory_entries WHERE project_id = $1) AS memories,
        (SELECT COUNT(*)::text FROM project_index_entries WHERE project_id = $1) AS index_entries,
        (SELECT COUNT(*)::text FROM project_relations WHERE source_project_id = $1 OR target_project_id = $1) AS relations`,
      [projectA2.id]
    );
    for (const count of Object.values(ownedRowsBeforeDelete.rows[0])) assert.ok(Number(count) > 0);

    // Project deletion deliberately hard-cascades Projects-owned context rows. Artifact data lives in another service.
    await projectStore.deleteProject(projectA2.id, ownerA);
    const ownedRowsAfterDelete = await getProjectsPool().query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*)::text FROM project_links WHERE project_id = $1) AS links,
        (SELECT COUNT(*)::text FROM project_briefs WHERE project_id = $1) AS briefs,
        (SELECT COUNT(*)::text FROM project_memory_entries WHERE project_id = $1) AS memories,
        (SELECT COUNT(*)::text FROM project_index_entries WHERE project_id = $1) AS index_entries,
        (SELECT COUNT(*)::text FROM project_relations WHERE source_project_id = $1 OR target_project_id = $1) AS relations`,
      [projectA2.id]
    );
    assert.deepEqual(ownedRowsAfterDelete.rows[0], {
      links: "0",
      briefs: "0",
      memories: "0",
      index_entries: "0",
      relations: "0"
    });
    assert.equal((await linksStore.listProjectLinksByTarget({
      targetService: "artifacts", targetResourceType: "artifact_item", targetResourceId: indexInput.resourceId
    }, ownerA)).items.length, 0);
    assert.equal((await relationStore.listProjectRelations(projectA.id, ownerA))?.items.length, 0);
  } finally {
    await getProjectsPool().query(`DELETE FROM projects WHERE owner_account_id = ANY($1::text[])`, [[ownerA, ownerB]]);
    await getProjectsPool().end();
  }
});
