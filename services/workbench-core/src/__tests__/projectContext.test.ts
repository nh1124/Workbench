import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
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

const mindmapDocument = {
  id: "mindmap-1",
  title: "Launch map",
  description: "Decision tree for launch planning.",
  mode: "logical_tree" as const,
  projectId: "project-primary",
  projectName: "Primary",
  body: {
    root: {
      id: "root",
      title: "Launch",
      children: [
        { id: "risk", title: "Risk", note: "Capacity" },
        { id: "action", title: "Action", children: [{ id: "owner", title: "Owner" }] }
      ]
    }
  },
  tags: ["planning"],
  version: 4,
  updatedAt: "2026-06-29T00:00:00.000Z"
};

const wbsPlan = {
  id: "wbs-1",
  title: "Launch WBS",
  description: "Execution work breakdown.",
  projectId: "project-primary",
  projectName: "Primary",
  settings: { calendar: "standard" },
  rollup: {
    effortHours: 42,
    progress: 50,
    itemCount: 6,
    doneCount: 3
  },
  version: 7,
  updatedAt: "2026-06-30T00:00:00.000Z"
};

before(() => {
  // Tests replace fetch per case because all service clients use the platform fetch API.
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe("Project context Artifact orchestration", () => {
  it("builds a deterministic Mindmap index entry for Project context discovery", () => {
    const parsed = contextModule.parseMindmapDocument(mindmapDocument);
    const entry = contextModule.buildMindmapIndexEntry(parsed) as Record<string, unknown>;

    assert.equal(entry.sourceService, "mindmaps");
    assert.equal(entry.resourceType, "mindmap_document");
    assert.equal(entry.resourceId, "mindmap-1");
    assert.equal(entry.associationKind, "primary");
    assert.equal(entry.path, "mindmaps/mindmap-1");
    assert.equal(entry.title, "Launch map");
    assert.equal(entry.summarySource, "deterministic");
    assert.equal(entry.sourceVersion, "4");
    assert.equal(entry.sourceUpdatedAt, "2026-06-29T00:00:00.000Z");
    assert.match(String(entry.summaryText), /Logical Tree/);
    assert.match(String(entry.summaryText), /Launch/);
    assert.match(String(entry.summaryText), /Capacity/);
    assert.match(String(entry.contentHash), /^[a-f0-9]{64}$/);
    assert.deepEqual(entry.metadataJson, {
      mode: "logical_tree",
      projectName: "Primary",
      tags: ["planning"],
      nodeCount: 4
    });
  });

  it("builds a deterministic WBS index entry for Project context discovery", () => {
    const parsed = contextModule.parseWbsPlan(wbsPlan);
    const entry = contextModule.buildWbsIndexEntry(parsed) as Record<string, unknown>;

    assert.equal(entry.sourceService, "wbs");
    assert.equal(entry.resourceType, "wbs_plan");
    assert.equal(entry.resourceId, "wbs-1");
    assert.equal(entry.associationKind, "primary");
    assert.equal(entry.path, "wbs/wbs-1");
    assert.equal(entry.title, "Launch WBS");
    assert.equal(entry.summarySource, "deterministic");
    assert.equal(entry.sourceVersion, "7");
    assert.equal(entry.sourceUpdatedAt, "2026-06-30T00:00:00.000Z");
    assert.match(String(entry.summaryText), /WBS/);
    assert.match(String(entry.summaryText), /42h/);
    assert.match(String(entry.summaryText), /50%/);
    assert.match(String(entry.contentHash), /^[a-f0-9]{64}$/);
    assert.deepEqual(entry.metadataJson, {
      projectName: "Primary",
      rollup: wbsPlan.rollup
    });
  });

  it("live-resolves supported Project link metadata with the caller bearer and never returns target bodies", async () => {
    const links = [
      {
        id: "link-note",
        projectId: "project-primary",
        targetService: "notes",
        targetResourceType: "note",
        targetResourceId: "note-1",
        relationType: "reference",
        titleSnapshot: "Stale note",
        summarySnapshot: "Stale note summary",
        metadataJson: {}
      },
      {
        id: "link-task",
        projectId: "project-primary",
        targetService: "tasks",
        targetResourceType: "task",
        targetResourceId: "task-1",
        relationType: "reference",
        titleSnapshot: "Stale task",
        metadataJson: {}
      },
      {
        id: "link-artifact",
        projectId: "project-primary",
        targetService: "artifacts",
        targetResourceType: "artifact_item",
        targetResourceId: "artifact-1",
        relationType: "secondary_membership",
        titleSnapshot: "Stale artifact",
        metadataJson: {}
      }
    ];
    const targetAuthorizations: string[] = [];

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      assert.equal(authorization, "Bearer caller-token");
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary/links") {
        return jsonResponse({ items: links, nextCursor: "cursor-2" });
      }
      targetAuthorizations.push(authorization ?? "");
      if (url.origin === "http://notes.test" && url.pathname === "/notes/note-1") {
        return jsonResponse({
          id: "note-1",
          title: "Live note",
          content: "  Current   note body with private details. ",
          updatedAt: "2026-06-23T01:00:00.000Z"
        });
      }
      if (url.origin === "http://tasks.test" && url.pathname === "/tasks/task-1") {
        return jsonResponse({
          id: "task-1",
          title: "Live task",
          notes: "Current task notes",
          status: "todo",
          context: "project-primary",
          updatedAt: "2026-06-23T02:00:00.000Z"
        });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/items/artifact-1") {
        return jsonResponse({ ...artifactItem, title: "Live artifact", contentMarkdown: "Current artifact body" });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const page = await contextModule.listProjectLinksResolved("caller-token", "project-primary");
    assert.equal(page.nextCursor, "cursor-2");
    const resolved = page.items as Array<Record<string, unknown>>;
    assert.deepEqual(resolved.map((link) => link.titleSnapshot), ["Live note", "Live task", "Live artifact"]);
    assert.deepEqual(resolved.map((link) => link.targetResolution), ["live", "live", "live"]);
    assert.equal(resolved[0]?.summarySnapshot, "Stale note summary");
    assert.equal(resolved[1]?.summarySnapshot, "todo · project-primary");
    assert.equal(resolved[2]?.summarySnapshot, "note · /Architecture.md");
    assert.equal("content" in (resolved[0] ?? {}), false, "raw Note bodies must not be embedded");
    assert.equal("notes" in (resolved[1] ?? {}), false, "raw Task bodies must not be embedded");
    assert.equal("contentMarkdown" in (resolved[2] ?? {}), false, "raw Artifact bodies must not be embedded");
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes("Current note body with private details"), false);
    assert.equal(serialized.includes("Current task notes"), false);
    assert.equal(serialized.includes("Current artifact body"), false);
    assert.deepEqual(targetAuthorizations, ["Bearer caller-token", "Bearer caller-token", "Bearer caller-token"]);
  });

  it("falls back to stored snapshots for cross-owner 404 and upstream failure without leaking error bodies", async () => {
    const links = [
      {
        id: "link-cross-owner",
        projectId: "project-primary",
        targetService: "notes",
        targetResourceType: "note",
        targetResourceId: "other-owner-note",
        relationType: "reference",
        titleSnapshot: "Allowed historical title",
        summarySnapshot: "Allowed historical summary",
        metadataJson: {}
      },
      {
        id: "link-unavailable",
        projectId: "project-primary",
        targetService: "tasks",
        targetResourceType: "task",
        targetResourceId: "task-down",
        relationType: "reference",
        titleSnapshot: "Cached task title",
        summarySnapshot: "Cached task summary",
        metadataJson: {}
      }
    ];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test") return jsonResponse({ items: links });
      if (url.origin === "http://notes.test") {
        return jsonResponse({ message: "not found", secret: "other-owner-body" }, 404);
      }
      if (url.origin === "http://tasks.test") {
        return jsonResponse({ message: "temporarily down", diagnostic: "upstream-private-detail" }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const page = await contextModule.listProjectLinksResolved("caller-token", "project-primary");
    const resolved = page.items as Array<Record<string, unknown>>;
    assert.deepEqual(resolved.map((link) => link.targetResolution), ["snapshot", "snapshot"]);
    assert.deepEqual(resolved.map((link) => link.titleSnapshot), ["Allowed historical title", "Cached task title"]);
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes("other-owner-body"), false);
    assert.equal(serialized.includes("upstream-private-detail"), false);
  });

  it("does not live-resolve a link returned for a different Project boundary", async () => {
    let targetReads = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test") {
        return jsonResponse({
          items: [{
            id: "link-wrong-project",
            projectId: "project-other",
            targetService: "notes",
            targetResourceType: "note",
            targetResourceId: "note-1",
            relationType: "reference",
            titleSnapshot: "Snapshot only"
          }]
        });
      }
      targetReads += 1;
      return jsonResponse({ title: "Must not be read" });
    };

    await assert.rejects(
      contextModule.listProjectLinksResolved("caller-token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.code === "INVALID_PROJECT_LINK_LIST_RESPONSE"
    );
    assert.equal(targetReads, 0);
  });

  it("fails closed when Projects returns a malformed link page", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test") return jsonResponse({ nextCursor: "looks-valid" });
      throw new Error(`Unexpected target read: ${url}`);
    };

    await assert.rejects(
      contextModule.listProjectLinksResolved("caller-token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.status === 502 &&
        error.code === "INVALID_PROJECT_LINK_LIST_RESPONSE"
    );

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test") return jsonResponse({ items: [], nextCursor: "" });
      throw new Error(`Unexpected target read: ${url}`);
    };
    await assert.rejects(
      contextModule.listProjectLinksResolved("caller-token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError &&
        error.code === "INVALID_PROJECT_LINK_LIST_RESPONSE"
    );
  });

  it("live-resolves links inside a valid context pack and rejects malformed context identity", async () => {
    let malformed = false;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary/context") {
        if (malformed) {
          return jsonResponse({ project: { id: "project-other", name: "Other" }, truncation: { maxChars: 100, truncatedSections: [] } });
        }
        return jsonResponse({
          project: {
            id: "project-primary",
            name: "Primary",
            description: "",
            status: "active",
            updatedAt: "2026-06-23T00:00:00.000Z"
          },
          links: [{
            id: "context-link-note",
            projectId: "project-primary",
            targetService: "notes",
            targetResourceType: "note",
            targetResourceId: "note-context",
            relationType: "reference",
            titleSnapshot: "Stale context title"
          }],
          truncation: { maxChars: 12_000, truncatedSections: [] }
        });
      }
      if (url.origin === "http://notes.test" && url.pathname === "/notes/note-context") {
        return jsonResponse({ title: "Live context title", content: "Live context summary" });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const context = await contextModule.getProjectContextWithResolvedLinks("caller-token", "project-primary");
    const link = (context.links as Array<Record<string, unknown>>)[0];
    assert.equal(link?.titleSnapshot, "Live context title");
    assert.equal(link?.summarySnapshot, undefined);
    assert.equal(JSON.stringify(context).includes("Live context summary"), false);

    malformed = true;
    await assert.rejects(
      contextModule.getProjectContextWithResolvedLinks("caller-token", "project-primary"),
      (error: unknown) =>
        error instanceof contextModule.ProjectContextError && error.code === "INVALID_PROJECT_CONTEXT_RESPONSE"
    );
  });

  it("keeps live-resolved context links within the Projects-declared character budget", async () => {
    const links = ["a", "b", "c"].map((id) => ({
      id: `link-${id}`,
      projectId: "project-primary",
      targetService: "artifacts",
      targetResourceType: "artifact",
      targetResourceId: `artifact-${id}`,
      relationType: "reference",
      titleSnapshot: id,
      summarySnapshot: id
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === "http://projects.test") {
        return jsonResponse({
          project: {
            id: "project-primary",
            name: "Primary",
            description: "",
            status: "active",
            updatedAt: "2026-06-23T00:00:00.000Z"
          },
          links,
          truncation: { maxChars: 1_600, truncatedSections: [] }
        });
      }
      if (url.origin === "http://artifacts.test") {
        return jsonResponse({ name: `Live ${url.pathname}`, description: "x".repeat(800) });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const context = await contextModule.getProjectContextWithResolvedLinks("caller-token", "project-primary");
    assert.ok(JSON.stringify(context).length <= 1_600);
    const resolvedLinks = context.links as Array<Record<string, unknown>>;
    assert.equal(resolvedLinks.some((link) => link.targetResolution === "live"), true);
    assert.equal(resolvedLinks.some((link) => link.targetResolution === undefined), true);
  });

  it("treats malformed Artifact responses as a best-effort invalidation miss", async () => {
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      assert.deepEqual(await contextModule.listArtifactProjectIdsBestEffort("token", { id: "partial" }), []);
    } finally {
      console.warn = originalWarn;
    }
  });

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

    const snapshot = await contextModule.removeArtifactItemWithProjectCleanup("token", "folder-1");

    assert.ok(events.indexOf("artifact-delete") > events.indexOf("subtree-read"));
    assert.ok(events.indexOf("artifact-delete") > events.indexOf("links-read:child-1"));
    assert.deepEqual(deletedLinks.sort(), ["link-child", "link-folder"]);
    assert.deepEqual(
      contextModule.projectIdsFromArtifactDeletionSnapshot(snapshot).sort(),
      ["project-primary", "secondary-child", "secondary-folder"]
    );
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

  it("upserts and tombstones Mindmap index entries on document mutations", async () => {
    const calls: Array<{ action: string; projectId: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const match = url.pathname.match(/^\/projects\/([^/]+)\/index-entries\/(upsert|tombstone)$/);
      if (url.origin === "http://projects.test" && method === "POST" && match) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ action: match[2], projectId: match[1], body });
        return jsonResponse({ status: "ok" });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const movedDocument = {
      ...mindmapDocument,
      projectId: "project-next",
      projectName: "Next",
      version: 5,
      updatedAt: "2026-06-30T00:00:00.000Z"
    };

    await contextModule.maintainMindmapIndex("token", mindmapDocument);
    await contextModule.reconcileMindmapMutationBestEffort("token", mindmapDocument, movedDocument);
    await contextModule.cleanupDeletedMindmapBestEffort("token", movedDocument);

    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => [call.action, call.projectId]),
      [
        ["upsert", "project-primary"],
        ["tombstone", "project-primary"],
        ["upsert", "project-next"],
        ["tombstone", "project-next"]
      ]
    );
    const upsertEntry = calls[0]?.body.entry as Record<string, unknown>;
    assert.equal(upsertEntry.sourceService, "mindmaps");
    assert.equal(upsertEntry.resourceType, "mindmap_document");
    assert.equal(upsertEntry.resourceId, "mindmap-1");
    assert.deepEqual(calls[1]?.body, {
      sourceService: "mindmaps",
      resourceType: "mindmap_document",
      resourceId: "mindmap-1"
    });
  });

  it("rebuilds Mindmap index entries with pagination and tombstones drift", async () => {
    const secondDocument = {
      ...mindmapDocument,
      id: "mindmap-2",
      title: "Follow-up map",
      version: 2,
      updatedAt: "2026-06-28T00:00:00.000Z"
    };
    const bulkEntries: unknown[] = [];
    const tombstones: unknown[] = [];
    let mindmapPages = 0;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary" && method === "GET") {
        return jsonResponse({ id: "project-primary", name: "Primary" });
      }
      if (url.origin === "http://mindmaps.test" && url.pathname === "/mindmaps" && method === "GET") {
        mindmapPages += 1;
        assert.equal(url.searchParams.get("projectId"), "project-primary");
        assert.equal(url.searchParams.get("limit"), "100");
        return url.searchParams.get("cursor") === "mindmaps-2"
          ? jsonResponse({ items: [secondDocument] })
          : jsonResponse({ items: [mindmapDocument], nextCursor: "mindmaps-2" });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/bulk-upsert")) {
        const payload = JSON.parse(String(init?.body)) as { entries: unknown[] };
        bulkEntries.push(...payload.entries);
        return jsonResponse({ items: payload.entries });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries") && method === "GET") {
        assert.equal(url.searchParams.get("sourceService"), "mindmaps");
        assert.equal(url.searchParams.get("resourceType"), "mindmap_document");
        return jsonResponse({
          items: [
            { sourceService: "mindmaps", resourceType: "mindmap_document", resourceId: "mindmap-1" },
            { sourceService: "mindmaps", resourceType: "mindmap_document", resourceId: "stale-map" }
          ]
        });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries/tombstone")) {
        tombstones.push(JSON.parse(String(init?.body)));
        return jsonResponse({ tombstoned: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await contextModule.rebuildProjectMindmapIndex("token", "project-primary");

    assert.equal(mindmapPages, 2);
    assert.equal(bulkEntries.length, 2);
    assert.deepEqual(
      bulkEntries.map((entry) => (entry as Record<string, unknown>).resourceId),
      ["mindmap-1", "mindmap-2"]
    );
    assert.equal(result.indexed, 2);
    assert.equal(result.tombstoned, 1);
    assert.deepEqual(tombstones, [
      { sourceService: "mindmaps", resourceType: "mindmap_document", resourceId: "stale-map" }
    ]);
  });

  it("keeps Project index rebuild useful when the Mindmap service is unavailable", async () => {
    let artifactIndexListed = false;

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary" && method === "GET") {
        return jsonResponse({ id: "project-primary", name: "Primary" });
      }
      if (url.origin === "http://artifacts.test" && url.pathname === "/artifacts/tree/list") {
        return jsonResponse({ items: [] });
      }
      if (url.origin === "http://projects.test" && url.pathname === "/projects/project-primary/links") {
        return jsonResponse({ items: [] });
      }
      if (url.origin === "http://projects.test" && url.pathname.endsWith("/index-entries") && method === "GET") {
        if (url.searchParams.get("sourceService") === "artifacts") {
          artifactIndexListed = true;
          return jsonResponse({ items: [] });
        }
        return jsonResponse({ items: [] });
      }
      if (url.origin === "http://mindmaps.test" && url.pathname === "/mindmaps") {
        return jsonResponse({ message: "temporarily down" }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await contextModule.rebuildProjectIndex("token", "project-primary");
    const artifacts = result.artifacts as Record<string, unknown>;
    const mindmaps = result.mindmaps as Record<string, unknown>;

    assert.equal(artifactIndexListed, true);
    assert.equal(artifacts.indexed, 0);
    assert.equal(mindmaps.status, "error");
    assert.equal(mindmaps.service, "mindmaps");
    assert.equal(mindmaps.statusCode, 503);
  });
});
