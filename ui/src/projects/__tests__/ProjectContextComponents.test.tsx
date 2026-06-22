// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "../../lib/api";
import type { ProjectBriefRecord, ProjectContextPack, ProjectMemoryEntry } from "../../types/models";
import { ProjectBriefPanel } from "../components/ProjectBriefPanel";
import { ProjectIndexPanel } from "../components/ProjectIndexPanel";
import { ProjectMemoryPanel } from "../components/ProjectMemoryPanel";
import { useProjectContext } from "../hooks/useProjectContext";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const brief: ProjectBriefRecord = {
  projectId: "project-a",
  contentMarkdown: "original brief",
  version: 1,
  updatedByKind: "user",
  updatedAt: "2026-06-20T00:00:00.000Z"
};

function context(projectId: string, projectName: string): ProjectContextPack {
  return {
    project: {
      id: projectId,
      name: projectName,
      description: "",
      status: "active",
      ownerAccountId: "owner-a",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z"
    },
    truncation: { maxChars: 12000, truncatedSections: [] }
  };
}

function ContextHarness({ projectId }: { projectId: string }) {
  const result = useProjectContext(projectId);
  return <div>{result.context?.project.name ?? (result.error ? "context error" : "no context")}</div>;
}

describe("Project context components", () => {
  it("shows a brief version conflict, reloads, and describes summary freshness conservatively", async () => {
    const conflict = Object.assign(new Error("version conflict"), { status: 409 });
    vi.spyOn(projectsApi, "updateBrief").mockRejectedValue(conflict);
    vi.spyOn(projectsApi, "getBrief").mockResolvedValue({
      ...brief,
      contentMarkdown: "latest brief",
      version: 2,
      updatedAt: "2026-06-21T00:00:00.000Z"
    });

    render(
      <ProjectBriefPanel
        projectId="project-a"
        brief={brief}
        generatedSummary={{
          projectId: "project-a",
          summaryText: "generated digest",
          source: "deterministic",
          updatedAt: "2026-06-20T01:00:00.000Z"
        }}
        loadedSectionTimestamps={["2026-06-20T02:00:00.000Z"]}
      />
    );

    expect(screen.getByText(/Possibly stale: loaded Project context changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Project brief"), { target: { value: "my update" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));

    expect((await screen.findByRole("alert")).textContent).toContain("changed in another session");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest brief" }));

    await waitFor(() => expect(projectsApi.getBrief).toHaveBeenCalledWith("project-a"));
    expect(await screen.findByDisplayValue("latest brief")).toBeTruthy();
  });

  it("renders memory authority and complete available provenance", async () => {
    const memory: ProjectMemoryEntry = {
      id: "memory-a",
      projectId: "project-a",
      kind: "observation",
      bodyMarkdown: "Observed durable behavior",
      authority: "agent_observed",
      sourceService: "artifacts",
      sourceResourceType: "artifact_item",
      sourceResourceId: "artifact-42",
      confidence: 0.83,
      status: "active",
      createdByKind: "agent",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z"
    };
    vi.spyOn(projectsApi, "listMemories").mockResolvedValue({ items: [memory] });

    render(<ProjectMemoryPanel projectId="project-a" />);

    expect(await screen.findByText("Observed durable behavior")).toBeTruthy();
    expect(screen.getByText("agent observed").className).toContain("authority-agent_observed");
    expect(screen.getByText("created by agent")).toBeTruthy();
    expect(screen.getByText("artifacts/artifact_item · artifact-42")).toBeTruthy();
    expect(screen.getByText("confidence 83%")).toBeTruthy();
  });

  it("does not let an older Project context response replace the current Project", async () => {
    let resolveOld: ((value: ProjectContextPack) => void) | undefined;
    vi.spyOn(projectsApi, "getContext").mockImplementation((projectId) => {
      if (projectId === "project-a") {
        return new Promise<ProjectContextPack>((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve(context("project-b", "Project B"));
    });

    const view = render(<ContextHarness projectId="project-a" />);
    view.rerender(<ContextHarness projectId="project-b" />);
    expect(await screen.findByText("Project B")).toBeTruthy();

    await act(async () => {
      resolveOld?.(context("project-a", "Project A"));
      await Promise.resolve();
    });

    expect(screen.getByText("Project B")).toBeTruthy();
    expect(screen.queryByText("Project A")).toBeNull();
  });

  it("does not let rebuild completion supersede a newer index search", async () => {
    let resolveRebuild: (() => void) | undefined;
    let resolveSearch: ((value: Awaited<ReturnType<typeof projectsApi.searchIndex>>) => void) | undefined;
    const rebuild = new Promise<void>((resolve) => { resolveRebuild = resolve; });
    const newerSearch = new Promise<Awaited<ReturnType<typeof projectsApi.searchIndex>>>((resolve) => {
      resolveSearch = resolve;
    });
    let calls = 0;
    vi.spyOn(projectsApi, "searchIndex").mockImplementation((_projectId, filters) => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ items: [] });
      if (filters?.q === "new intent") return newerSearch;
      return Promise.resolve({ items: [{
        id: "old-index", projectId: "project-a", sourceService: "artifacts", resourceType: "note",
        resourceId: "old", associationKind: "primary", title: "Old results", summaryText: "old",
        summarySource: "deterministic", sourceUpdatedAt: brief.updatedAt, indexedAt: brief.updatedAt,
        metadataJson: {}
      }] });
    });
    vi.spyOn(projectsApi, "rebuildIndex").mockReturnValue(rebuild.then(() => ({ indexed: 1 })));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ProjectIndexPanel projectId="project-a" />);
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Repair index" }));
    fireEvent.change(screen.getByLabelText("Search Project index"), { target: { value: "new intent" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(calls).toBe(2));

    await act(async () => {
      resolveRebuild?.();
      await Promise.resolve();
    });
    expect(calls).toBe(2);

    await act(async () => {
      resolveSearch?.({ items: [{
        id: "new-index", projectId: "project-a", sourceService: "artifacts", resourceType: "note",
        resourceId: "new", associationKind: "primary", title: "New results", summaryText: "new",
        summarySource: "deterministic", sourceUpdatedAt: brief.updatedAt, indexedAt: brief.updatedAt,
        metadataJson: {}
      }] });
      await Promise.resolve();
    });
    expect(await screen.findByText("New results")).toBeTruthy();
    expect(screen.queryByText("Old results")).toBeNull();
  });

  it("does not let archive completion supersede a newer memory search", async () => {
    const existingMemory: ProjectMemoryEntry = {
      id: "memory-old", projectId: "project-a", kind: "decision", bodyMarkdown: "Archive me",
      authority: "user_confirmed", status: "active", createdByKind: "user",
      createdAt: brief.updatedAt, updatedAt: brief.updatedAt
    };
    let resolveArchive: (() => void) | undefined;
    let resolveSearch: ((value: Awaited<ReturnType<typeof projectsApi.listMemories>>) => void) | undefined;
    const archive = new Promise<void>((resolve) => { resolveArchive = resolve; });
    const newerSearch = new Promise<Awaited<ReturnType<typeof projectsApi.listMemories>>>((resolve) => {
      resolveSearch = resolve;
    });
    let calls = 0;
    vi.spyOn(projectsApi, "listMemories").mockImplementation((_projectId, filters) => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ items: [existingMemory] });
      if (filters?.q === "new intent") return newerSearch;
      return Promise.resolve({ items: [] });
    });
    vi.spyOn(projectsApi, "archiveMemory").mockReturnValue(archive.then(() => existingMemory));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ProjectMemoryPanel projectId="project-a" />);
    expect(await screen.findByText("Archive me")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.change(screen.getByLabelText("Search Project memory"), { target: { value: "new intent" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(calls).toBe(2));

    await act(async () => {
      resolveArchive?.();
      await Promise.resolve();
    });
    expect(calls).toBe(2);

    await act(async () => {
      resolveSearch?.({ items: [{ ...existingMemory, id: "memory-new", bodyMarkdown: "New memory result" }] });
      await Promise.resolve();
    });
    expect(await screen.findByText("New memory result")).toBeTruthy();
  });
});
