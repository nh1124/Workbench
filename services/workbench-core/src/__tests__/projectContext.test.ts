import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.PROJECTS_SERVICE_URL ||= "http://projects.test";

const contextModule = await import("../projectContext.js");
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" }
  });
}

const artifactItem = {
  id: "artifact-1",
  projectId: "project-primary",
  projectName: "Primary",
  kind: "note" as const,
  title: "Architecture",
  path: "/Architecture.md",
  version: 3,
  updatedAt: "2026-06-20T00:00:00.000Z",
  contentMarkdown: "# Architecture\n\nA short durable summary.",
  tags: ["design"]
};

before(() => {
  // Tests replace fetch per case because all service clients use the platform fetch API.
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe("Project context Artifact orchestration", () => {
  it("builds a deterministic primary index entry", () => {
    const entry = contextModule.buildArtifactIndexEntry(artifactItem, "primary");
    assert.equal(entry.sourceService, "artifacts");
    assert.equal(entry.resourceType, "note");
    assert.equal(entry.resourceId, artifactItem.id);
    assert.equal(entry.associationKind, "primary");
    assert.equal(entry.summarySource, "deterministic");
    assert.match(String(entry.summaryText), /Architecture/);
    assert.match(String(entry.contentHash), /^[a-f0-9]{64}$/);
  });

  it("rejects removal of the primary membership without touching Projects links", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "http://artifacts.test/artifacts/items/artifact-1") return jsonResponse(artifactItem);
      throw new Error(`Unexpected request: ${url}`);
    };

    await assert.rejects(
      contextModule.unlinkArtifactFromProject("token", "artifact-1", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.status === 409 &&
        error.code === "PRIMARY_MEMBERSHIP_CANNOT_BE_REMOVED"
    );
    assert.deepEqual(calls, ["http://artifacts.test/artifacts/items/artifact-1"]);
  });

  it("preserves a successful membership link when derived index maintenance fails", async () => {
    const link = {
      id: "link-1",
      projectId: "project-secondary",
      targetService: "artifacts",
      targetResourceType: "artifact_item",
      targetResourceId: artifactItem.id,
      relationType: "secondary_membership",
      metadataJson: { note: "Finance relevance" }
    };
    let createPayload: Record<string, unknown> | undefined;
    let indexAttempts = 0;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/artifact-1") {
        return jsonResponse(artifactItem);
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-secondary" && method === "GET") {
        return jsonResponse({ id: "project-secondary", name: "Secondary" });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary" && method === "GET") {
        return jsonResponse({ id: "project-primary", name: "Primary" });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-secondary/links" && method === "POST") {
        createPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(link, 201);
      }
      if (url.origin === "http://projects.test" && url.pathname === "/project-links" && method === "GET") {
        return jsonResponse({ items: [link] });
      }
      if (url.origin === "http://projects.test" && url.pathname.includes("/index-entries/upsert")) {
        indexAttempts += 1;
        return jsonResponse({ message: "index unavailable" }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await contextModule.linkArtifactToProject("token", artifactItem.id, {
      projectId: "project-secondary",
      note: "Finance relevance",
      expectedArtifactVersion: 3
    });

    assert.equal(createPayload?.relationType, "secondary_membership");
    assert.equal(createPayload?.targetResourceType, "artifact_item");
    assert.equal(indexAttempts, 1);
    const memberships = result.memberships as Array<Record<string, unknown>>;
    assert.deepEqual(
      memberships.map((membership) => [membership.projectId, membership.role]),
      [
        ["project-primary", "primary"],
        ["project-secondary", "secondary"]
      ]
    );
  });

  it("reports deletion impact without treating secondary memberships as owned Artifacts", async () => {
    const secondaryLink = {
      id: "link-secondary",
      projectId: "project-primary",
      targetService: "artifacts",
      targetResourceType: "artifact_item",
      targetResourceId: "artifact-elsewhere",
      relationType: "secondary_membership"
    };
    let projectDeleteAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary") {
        if (method === "DELETE") projectDeleteAttempts += 1;
        return jsonResponse({ id: "project-primary", name: "Primary" });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        return jsonResponse({ items: [artifactItem] });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary/links") {
        return jsonResponse({ items: [secondaryLink] });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const impact = await contextModule.getProjectDeletionImpact("token", "project-primary");
    assert.equal(impact.canDelete, false);
    assert.equal(impact.primaryArtifactCount, 1);
    assert.equal(impact.secondaryArtifactCount, 1);
    assert.deepEqual(impact.secondaryMemberships, [
      { linkId: "link-secondary", artifactItemId: "artifact-elsewhere" }
    ]);

    await assert.rejects(
      contextModule.assertProjectCanBeDeleted("token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.status === 409 &&
        error.code === "PROJECT_HAS_PRIMARY_ARTIFACTS"
    );
    await assert.rejects(
      contextModule.deleteProjectWithGuard("token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError && error.code === "PROJECT_HAS_PRIMARY_ARTIFACTS"
    );
    assert.equal(projectDeleteAttempts, 0, "guarded delete must not call Projects DELETE");
  });

  it("blocks malformed generic secondary membership targets", async () => {
    await assert.rejects(
      contextModule.createProjectLinkWithValidation("token", "project-secondary", {
        targetService: "notes",
        targetResourceType: "note",
        targetResourceId: "note-1",
        relationType: "  secondary_membership  "
      }),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.status === 400 &&
        error.code === "INVALID_SECONDARY_MEMBERSHIP_TARGET"
    );
  });

  it("rejects a non-string relationType instead of falling back to a generic reference", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("No service request expected");
    };

    await assert.rejects(
      contextModule.createProjectLinkWithValidation("token", "project-secondary", {
        targetService: "artifacts",
        targetResourceType: "artifact_item",
        targetResourceId: "artifact-1",
        relationType: { unsafe: true }
      }),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.status === 400 &&
        error.code === "INVALID_RELATION_TYPE"
    );
    assert.equal(requests, 0);
  });

  it("snapshots and cleans every descendant when deleting an Artifact folder", async () => {
    const folder = {
      ...artifactItem,
      id: "folder-1",
      kind: "folder" as const,
      title: "Folder",
      path: "/Folder",
      contentMarkdown: undefined
    };
    const child = {
      ...artifactItem,
      id: "child-1",
      title: "Child",
      path: "/Folder/Child.md"
    };
    const links = {
      "folder-1": {
        id: "link-folder",
        projectId: "secondary-folder",
        targetService: "artifacts",
        targetResourceType: "artifact_item",
        targetResourceId: "folder-1",
        relationType: "secondary_membership"
      },
      "child-1": {
        id: "link-child",
        projectId: "secondary-child",
        targetService: "artifacts",
        targetResourceType: "artifact_item",
        targetResourceId: "child-1",
        relationType: "secondary_membership"
      }
    } as const;
    const deletedLinks: string[] = [];
    const tombstones: Array<{ projectId: string; resourceId: string }> = [];
    const events: string[] = [];

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/folder-1" && method === "GET") {
        events.push("root-read");
        return jsonResponse(folder);
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        events.push("subtree-read");
        assert.equal(url.searchParams.get("projectId"), "project-primary");
        assert.equal(url.searchParams.get("pathPrefix"), "/Folder");
        return jsonResponse({ items: [folder, child] });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/project-links" && method === "GET") {
        const artifactId = url.searchParams.get("targetResourceId") as keyof typeof links;
        events.push(`links-read:${artifactId}`);
        return jsonResponse({ items: [links[artifactId]] });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/folder-1" && method === "DELETE") {
        events.push("artifact-delete");
        return jsonResponse(undefined, 204);
      }
      if (url.origin === "http://projects.test" && url.pathname.startsWith("/project-links/") && method === "DELETE") {
        const linkId = url.pathname.split("/").at(-1) as string;
        deletedLinks.push(linkId);
        return jsonResponse(undefined, 204);
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/tombstone")) {
        const projectId = url.pathname.split("/")[2];
        const payload = JSON.parse(String(init?.body)) as { resourceId: string };
        tombstones.push({ projectId, resourceId: payload.resourceId });
        return jsonResponse({ tombstoned: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await contextModule.removeArtifactItemWithProjectCleanup("token", "folder-1");

    assert.ok(events.indexOf("artifact-delete") > events.indexOf("subtree-read"));
    assert.ok(events.indexOf("artifact-delete") > events.indexOf("links-read:child-1"));
    assert.deepEqual(deletedLinks.sort(), ["link-child", "link-folder"]);
    assert.deepEqual(
      tombstones.sort((a, b) => `${a.projectId}:${a.resourceId}`.localeCompare(`${b.projectId}:${b.resourceId}`)),
      [
        { projectId: "project-primary", resourceId: "child-1" },
        { projectId: "project-primary", resourceId: "folder-1" },
        { projectId: "secondary-child", resourceId: "child-1" },
        { projectId: "secondary-folder", resourceId: "folder-1" }
      ]
    );
  });

  it("does not delete a folder when the complete subtree snapshot cannot be read", async () => {
    const folder = {
      ...artifactItem,
      id: "folder-subtree-failure",
      kind: "folder" as const,
      title: "Folder",
      path: "/Folder",
      contentMarkdown: undefined
    };
    let deleteCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/folder-subtree-failure") {
        if (method === "DELETE") deleteCalls += 1;
        return jsonResponse(folder);
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        return jsonResponse({ message: "subtree unavailable" }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await assert.rejects(
      contextModule.removeArtifactItemWithProjectCleanup("token", folder.id),
      /subtree unavailable/
    );
    assert.equal(deleteCalls, 0);
  });

  it("does not delete a folder when any descendant membership snapshot fails", async () => {
    const folder = {
      ...artifactItem,
      id: "folder-membership-failure",
      kind: "folder" as const,
      title: "Folder",
      path: "/Folder",
      contentMarkdown: undefined
    };
    const child = {
      ...artifactItem,
      id: "child-membership-failure",
      title: "Child",
      path: "/Folder/Child.md"
    };
    let deleteCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/folder-membership-failure") {
        if (method === "DELETE") deleteCalls += 1;
        return jsonResponse(folder);
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        return jsonResponse({ items: [folder, child] });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/project-links") {
        const targetId = url.searchParams.get("targetResourceId");
        if (targetId === child.id) return jsonResponse({ message: "membership unavailable" }, 503);
        return jsonResponse({ items: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await assert.rejects(
      contextModule.removeArtifactItemWithProjectCleanup("token", folder.id),
      /membership unavailable/
    );
    assert.equal(deleteCalls, 0);
  });

  it("indexes notes created through the shared Core-owned creation helper", async () => {
    let indexPayload: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/notes" && method === "POST") {
        return jsonResponse(artifactItem, 201);
      }
      if (url.origin === "http://projects.test" && url.pathname === "/project-links") {
        return jsonResponse({ items: [] });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/upsert")) {
        indexPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: "index-1" });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const created = await contextModule.createArtifactNoteWithIndex("token", { title: "Architecture" });
    assert.equal((created as { id: string }).id, artifactItem.id);
    const entry = indexPayload?.entry as Record<string, unknown>;
    assert.equal(entry.resourceId, artifactItem.id);
    assert.equal(entry.associationKind, "primary");
  });

  it("rebuilds from paged primary items plus secondary links and tombstones drift", async () => {
    const secondaryItem = {
      ...artifactItem,
      id: "artifact-secondary",
      projectId: "project-elsewhere",
      title: "Shared note",
      path: "/Shared.md"
    };
    const secondaryLink = {
      id: "link-secondary",
      projectId: "project-primary",
      targetService: "artifacts",
      targetResourceType: "artifact_item",
      targetResourceId: secondaryItem.id,
      relationType: "secondary_membership"
    };
    const bulkEntries: unknown[] = [];
    const tombstones: unknown[] = [];
    let treePages = 0;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary" && method === "GET") {
        return jsonResponse({ id: "project-primary", name: "Primary" });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        treePages += 1;
        return url.searchParams.get("cursor") === "tree-2"
          ? jsonResponse({ items: [] })
          : jsonResponse({ items: [artifactItem], nextCursor: "tree-2" });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary/links") {
        return jsonResponse({ items: [secondaryLink] });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/artifact-secondary") {
        return jsonResponse(secondaryItem);
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/bulk-upsert")) {
        const payload = JSON.parse(String(init?.body)) as { entries: unknown[] };
        bulkEntries.push(...payload.entries);
        return jsonResponse({ items: payload.entries });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries") && method === "GET") {
        return jsonResponse({
          items: [{ sourceService: "artifacts", resourceType: "file", resourceId: "stale-artifact" }]
        });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/tombstone")) {
        tombstones.push(JSON.parse(String(init?.body)));
        return jsonResponse({ tombstoned: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await contextModule.rebuildProjectArtifactIndex("token", "project-primary");
    assert.equal(treePages, 2);
    assert.equal(bulkEntries.length, 2);
    assert.equal(result.primary, 1);
    assert.equal(result.secondary, 1);
    assert.equal(result.tombstoned, 1);
    assert.deepEqual(tombstones, [
      { sourceService: "artifacts", resourceType: "file", resourceId: "stale-artifact" }
    ]);
  });
});
