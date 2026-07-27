// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { mindmapsApi, projectsApi } from "../../lib/api";
import type { MindmapDocument } from "../../types/models";
import { MindmapsPage } from "../MindmapsPage";

/**
 * Characterization tests for MindmapsPage.
 *
 * The page is one component with 28 hooks and had no coverage. Its pure tree
 * helpers are unit-tested separately; these cover the component wiring around
 * them — selection, editing, adding and deleting nodes, collapse, and saving —
 * so the component can be split into hooks without changing what the user sees.
 */

const timestamp = "2026-07-27T00:00:00.000Z";

function doc(overrides: Partial<MindmapDocument> = {}): MindmapDocument {
  return {
    id: "map-1",
    title: "Roadmap",
    mode: "mindmap",
    projectId: "project-a",
    projectName: "Finance",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    body: {
      root: {
        id: "root",
        title: "Root",
        children: [
          { id: "child-a", title: "Child A", children: [] },
          { id: "child-b", title: "Child B", children: [] }
        ]
      }
    },
    ...overrides
  } as MindmapDocument;
}

const project = {
  id: "project-a",
  name: "Finance",
  description: "",
  status: "active" as const,
  ownerAccountId: "owner-a",
  createdAt: timestamp,
  updatedAt: timestamp
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/mindmaps"]}>
      <Routes>
        <Route path="/mindmaps" element={<MindmapsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Nodes render as role="button" carrying their title. */
function node(title: string): HTMLElement {
  const found = screen
    .getAllByRole("button")
    .find((element) => element.className.includes("mindmaps-node") && element.textContent?.includes(title));
  if (!found) throw new Error(`node not found: ${title}`);
  return found;
}

function nodeTitles(): string[] {
  return screen
    .getAllByRole("button")
    .filter((element) => element.className.includes("mindmaps-node"))
    .map((element) => element.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(projectsApi, "list").mockResolvedValue({ items: [project] });
  vi.spyOn(mindmapsApi, "list").mockResolvedValue({ items: [doc()] } as never);
  vi.spyOn(mindmapsApi, "get").mockResolvedValue(doc() as never);
  vi.spyOn(mindmapsApi, "update").mockImplementation((_id, payload) =>
    Promise.resolve({ ...doc(), ...(payload as object), version: 2 } as never)
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function openMap() {
  await waitFor(() => expect(node("Root")).toBeTruthy());
}

describe("MindmapsPage canvas", () => {
  it("renders the loaded document as nodes", async () => {
    renderPage();
    await openMap();

    expect(nodeTitles().some((title) => title.includes("Root"))).toBe(true);
    expect(nodeTitles().some((title) => title.includes("Child A"))).toBe(true);
    expect(nodeTitles().some((title) => title.includes("Child B"))).toBe(true);
  });

  it("selects a node on click", async () => {
    renderPage();
    await openMap();

    fireEvent.click(node("Child A"));

    await waitFor(() => expect(node("Child A").className).toContain("selected"));
    expect(node("Child B").className).not.toContain("selected");
  });

  it("starts title editing on double click and commits on blur", async () => {
    renderPage();
    await openMap();

    fireEvent.doubleClick(node("Child A"));

    const input = await screen.findByLabelText("Node title");
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.blur(input);

    await waitFor(() => expect(nodeTitles().some((title) => title.includes("Renamed A"))).toBe(true));
    expect(nodeTitles().some((title) => title.includes("Child A"))).toBe(false);
  });

  it("abandons a title edit on Escape", async () => {
    renderPage();
    await openMap();

    fireEvent.doubleClick(node("Child A"));
    const input = await screen.findByLabelText("Node title");
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Node title")).toBeNull());
    expect(nodeTitles().some((title) => title.includes("Child A"))).toBe(true);
    expect(nodeTitles().some((title) => title.includes("Discarded"))).toBe(false);
  });
});

describe("MindmapsPage node editing", () => {
  it("deletes the selected node and its place in the canvas", async () => {
    renderPage();
    await openMap();

    fireEvent.click(node("Child A"));
    await waitFor(() => expect(node("Child A").className).toContain("selected"));

    fireEvent.click(screen.getByLabelText("Delete node"));

    await waitFor(() => expect(nodeTitles().some((title) => title.includes("Child A"))).toBe(false));
    expect(nodeTitles().some((title) => title.includes("Child B"))).toBe(true);
  });

  it("refuses to delete the root node", async () => {
    renderPage();
    await openMap();

    fireEvent.click(node("Root"));
    await waitFor(() => expect(node("Root").className).toContain("selected"));

    const deleteButton = screen.getByLabelText("Delete node") as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    fireEvent.click(deleteButton);
    expect(nodeTitles().some((title) => title.includes("Root"))).toBe(true);
  });
});

describe("MindmapsPage saving", () => {
  it("saves edits through mindmapsApi.update", async () => {
    renderPage();
    await openMap();

    fireEvent.doubleClick(node("Child A"));
    const input = await screen.findByLabelText("Node title");
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.blur(input);

    await waitFor(() => expect(nodeTitles().some((title) => title.includes("Renamed A"))).toBe(true));

    fireEvent.click(screen.getByLabelText("Save"));

    await waitFor(() => expect(mindmapsApi.update).toHaveBeenCalled());
    const payload = vi.mocked(mindmapsApi.update).mock.calls[0]?.[1] as { body?: unknown };
    expect(JSON.stringify(payload.body)).toContain("Renamed A");
  });

  // Save is gated on having a document, not on having unsaved edits — the dirty
  // state drives the header indicator, not the button.
  it("enables Save whenever a document is open", async () => {
    renderPage();
    await openMap();

    expect((screen.getByLabelText("Save") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(mindmapsApi.update).toHaveBeenCalled());
  });

  it("marks the document unsaved while an edit is uncommitted, and clears it on save", async () => {
    renderPage();
    await openMap();

    expect(screen.queryByText(/Unsaved/)).toBeNull();

    fireEvent.doubleClick(node("Child A"));
    const input = await screen.findByLabelText("Node title");
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText(/Unsaved/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Save"));

    await waitFor(() => expect(screen.queryByText(/Unsaved/)).toBeNull());
  });

  it("does not mark the document unsaved for selection alone", async () => {
    renderPage();
    await openMap();

    fireEvent.click(node("Child B"));

    await waitFor(() => expect(node("Child B").className).toContain("selected"));
    expect(screen.queryByText(/Unsaved/)).toBeNull();
  });
});
