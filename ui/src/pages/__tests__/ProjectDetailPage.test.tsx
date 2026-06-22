// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { artifactsApi, notesApi, projectsApi, tasksApi } from "../../lib/api";
import { ProjectDetailPage } from "../ProjectDetailPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(projectsApi, "get").mockResolvedValue({
    id: "project-a",
    name: "Finance",
    description: "Base Project details stay available.",
    status: "active",
    ownerAccountId: "owner-a",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T01:00:00.000Z"
  });
  vi.spyOn(projectsApi, "getContext").mockRejectedValue(new Error("context service unavailable"));
  vi.spyOn(notesApi, "projects").mockResolvedValue([]);
  vi.spyOn(tasksApi, "projects").mockResolvedValue([]);
  vi.spyOn(artifactsApi, "projects").mockResolvedValue([]);
  vi.spyOn(notesApi, "list").mockResolvedValue([]);
  vi.spyOn(tasksApi, "list").mockResolvedValue([]);
  vi.spyOn(artifactsApi, "list").mockResolvedValue([]);
  vi.spyOn(artifactsApi, "tree").mockResolvedValue([]);
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/project-a"]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/artifacts" element={<div>Artifacts destination</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function ProjectNavigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate("/projects/project-b")}>Open Project B</button>;
}

function renderSwitchablePage() {
  return render(
    <MemoryRouter initialEntries={["/projects/project-a"]}>
      <ProjectNavigation />
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProjectDetailPage context hardening", () => {
  it("preserves the base Project detail when the context request fails", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Finance" })).toBeTruthy();
    expect(screen.getByText("Base Project details stay available.")).toBeTruthy();
    expect(await screen.findByText(/Project context is unavailable on this server/)).toBeTruthy();
  });

  it("disables Project deletion while the verified impact contains a primary Artifact", async () => {
    vi.spyOn(projectsApi, "getDeletionImpact").mockResolvedValue({
      projectId: "project-a",
      primaryArtifactCount: 1,
      secondaryArtifactCount: 2,
      canDelete: false
    });
    renderPage();

    await screen.findByRole("heading", { name: "Finance" });
    fireEvent.click(screen.getByRole("button", { name: "Config" }));

    expect(await screen.findByText("Primary Artifact items")).toBeTruthy();
    expect(screen.getByText("Secondary memberships")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete Project" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Project deletion is blocked while primary Artifact items remain/)).toBeTruthy();
  });

  it("does not let a late base Project response replace the current route", async () => {
    let resolveProjectA: ((project: Awaited<ReturnType<typeof projectsApi.get>>) => void) | undefined;
    vi.mocked(projectsApi.get).mockImplementation((id) => {
      if (id === "project-a") {
        return new Promise((resolve) => { resolveProjectA = resolve; });
      }
      return Promise.resolve({
        id: "project-b",
        name: "Health",
        description: "Current Project B",
        status: "active",
        ownerAccountId: "owner-a",
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T01:00:00.000Z"
      });
    });

    renderSwitchablePage();
    fireEvent.click(screen.getByRole("button", { name: "Open Project B" }));
    expect(await screen.findByRole("heading", { name: "Health" })).toBeTruthy();

    await act(async () => {
      resolveProjectA?.({
        id: "project-a",
        name: "Finance",
        description: "Late Project A",
        status: "active",
        ownerAccountId: "owner-a",
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T01:00:00.000Z"
      });
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Health" })).toBeTruthy();
    expect(screen.queryByText("Late Project A")).toBeNull();
  });
});
