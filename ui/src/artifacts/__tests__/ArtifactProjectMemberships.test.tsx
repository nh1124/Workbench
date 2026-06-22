// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactsApi } from "../../lib/api";
import type { ArtifactItem } from "../../types/models";
import { ArtifactProjectMemberships } from "../components/ArtifactProjectMemberships";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item: ArtifactItem = {
  id: "artifact-a",
  projectId: "project-primary",
  projectName: "Primary Project",
  kind: "note",
  title: "Shared research",
  path: "/Shared research",
  parentPath: "/",
  scope: "project",
  tags: [],
  version: 3,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z"
};

describe("ArtifactProjectMemberships", () => {
  it("keeps the primary Artifact while unlinking only a secondary membership", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(artifactsApi, "listProjectMemberships")
      .mockResolvedValueOnce({
        artifactItemId: item.id,
        memberships: [
          { projectId: "project-primary", projectName: "Primary Project", role: "primary" },
          { projectId: "project-secondary", projectName: "Secondary Project", role: "secondary", linkId: "link-a" }
        ]
      })
      .mockResolvedValueOnce({
        artifactItemId: item.id,
        memberships: [{ projectId: "project-primary", projectName: "Primary Project", role: "primary" }]
      });
    vi.spyOn(artifactsApi, "unlinkProject").mockResolvedValue(undefined);

    render(
      <ArtifactProjectMemberships
        item={item}
        projects={[
          { id: "project-primary", name: "Primary Project", status: "active" },
          { id: "project-secondary", name: "Secondary Project", status: "active" }
        ]}
      />
    );

    expect(await screen.findByText("Secondary Project")).toBeTruthy();
    expect(screen.getByText("Primary Project")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove membership" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove membership" }));

    await waitFor(() => expect(artifactsApi.unlinkProject).toHaveBeenCalledWith("artifact-a", "project-secondary"));
    await waitFor(() => expect(within(screen.getByRole("list")).queryByText("Secondary Project")).toBeNull());
    expect(screen.getByText("Primary Project")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove membership" })).toBeNull();
  });
});
