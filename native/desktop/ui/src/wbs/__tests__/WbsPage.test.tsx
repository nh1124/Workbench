// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { projectsApi, wbsApi } from "../../lib/api";
import type { WbsItem, WbsPlan } from "../../types/models";
import { WbsPage } from "../WbsPage";

/**
 * Characterization tests for WbsPage.
 *
 * The page is one component with 31 hooks and had no coverage. Its pure tree
 * helpers are unit-tested separately; these cover the component wiring around
 * them — row rendering and order, selection, per-cell editing with its
 * commit-on-blur, deletion, and the unsaved indicator — so the component can be
 * split into hooks without changing what the user sees.
 */

const timestamp = "2026-07-27T00:00:00.000Z";

const plan: WbsPlan = {
  id: "plan-1",
  title: "Delivery",
  projectId: "project-a",
  projectName: "Finance",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp
};

function item(overrides: Partial<WbsItem> & { id: string; code: string }): WbsItem {
  return {
    planId: "plan-1",
    title: overrides.id,
    status: "todo",
    sortOrder: 0,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  } as WbsItem;
}

function baseItems(): WbsItem[] {
  return [
    item({ id: "a", code: "1", title: "Design" }),
    item({ id: "a1", code: "1.1", title: "Wireframes", parentId: "a" }),
    item({ id: "b", code: "2", title: "Build", sortOrder: 1 })
  ];
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
    <MemoryRouter initialEntries={["/wbs"]}>
      <Routes>
        <Route path="/wbs" element={<WbsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Rows carry their item id, which is the only stable handle on them. */
function row(itemId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`tr[data-wbs-item-id="${itemId}"]`);
  if (!found) throw new Error(`row not found: ${itemId}`);
  return found;
}

function rowIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("tr[data-wbs-item-id]")).map(
    (element) => element.dataset.wbsItemId ?? ""
  );
}

function titleInput(itemId: string): HTMLInputElement {
  return within(row(itemId)).getByLabelText("Work item title") as HTMLInputElement;
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
  vi.spyOn(projectsApi, "list").mockResolvedValue({ items: [project] });
  vi.spyOn(wbsApi, "listPlans").mockResolvedValue({ items: [plan] });
  vi.spyOn(wbsApi, "listItems").mockResolvedValue(baseItems());
  vi.spyOn(wbsApi, "updateItem").mockResolvedValue(baseItems());
  vi.spyOn(wbsApi, "removeItem").mockResolvedValue(baseItems().filter((entry) => entry.id !== "a1"));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function openPlan() {
  await waitFor(() => expect(rowIds().length).toBe(3));
}

describe("WbsPage table", () => {
  it("renders the plan's items as rows in tree order", async () => {
    renderPage();
    await openPlan();

    expect(rowIds()).toEqual(["a", "a1", "b"]);
    expect(within(row("a1")).getByText("1.1")).toBeTruthy();
    expect(titleInput("a1").value).toBe("Wireframes");
  });

  it("selects the first item once the plan loads", async () => {
    renderPage();
    await openPlan();

    expect(row("a").className).toContain("selected");
    expect(row("b").className).not.toContain("selected");
  });

  it("selects a row on click", async () => {
    renderPage();
    await openPlan();

    fireEvent.click(row("b"));

    await waitFor(() => expect(row("b").className).toContain("selected"));
    expect(row("a").className).not.toContain("selected");
  });
});

describe("WbsPage cell editing", () => {
  it("edits a title locally and commits it on blur", async () => {
    renderPage();
    await openPlan();

    fireEvent.change(titleInput("a1"), { target: { value: "Mockups" } });
    await waitFor(() => expect(titleInput("a1").value).toBe("Mockups"));
    expect(wbsApi.updateItem).not.toHaveBeenCalled();

    fireEvent.blur(titleInput("a1"));

    await waitFor(() => expect(wbsApi.updateItem).toHaveBeenCalledTimes(1));
    const [itemId, payload] = vi.mocked(wbsApi.updateItem).mock.calls[0]!;
    expect(itemId).toBe("a1");
    expect(payload).toMatchObject({ title: "Mockups", expectedVersion: 1 });
  });

  it("marks the plan unsaved while an edit is only local", async () => {
    renderPage();
    await openPlan();

    expect(screen.queryByText(/Unsaved/)).toBeNull();

    fireEvent.change(titleInput("a1"), { target: { value: "Mockups" } });

    await waitFor(() => expect(screen.getByText(/Unsaved/)).toBeTruthy());
  });

  it("commits a status change immediately, without waiting for blur", async () => {
    renderPage();
    await openPlan();

    const status = within(row("b")).getByLabelText("Status");
    fireEvent.change(status, { target: { value: "done" } });

    await waitFor(() => expect(wbsApi.updateItem).toHaveBeenCalledTimes(1));
    expect(vi.mocked(wbsApi.updateItem).mock.calls[0]![1]).toMatchObject({ status: "done" });
  });

  it("surfaces the error and reloads when a commit is rejected", async () => {
    vi.mocked(wbsApi.updateItem).mockRejectedValueOnce(new Error("version conflict"));
    renderPage();
    await openPlan();

    fireEvent.change(titleInput("a1"), { target: { value: "Mockups" } });
    fireEvent.blur(titleInput("a1"));

    await waitFor(() => expect(screen.getByText("version conflict")).toBeTruthy());
    // The reload puts the server's copy back, discarding the local edit.
    await waitFor(() => expect(titleInput("a1").value).toBe("Wireframes"));
  });
});

/** Delete lives in the item detail panel, which the toolbar opens — a row click does not. */
async function openDetailPanelFor(itemId: string) {
  fireEvent.click(row(itemId));
  await waitFor(() => expect(row(itemId).className).toContain("selected"));
  fireEvent.click(screen.getByLabelText("Item detail"));
  await waitFor(() => expect(screen.getByLabelText("Delete item")).toBeTruthy());
}

describe("WbsPage item deletion", () => {
  it("deletes the selected item and drops its row", async () => {
    renderPage();
    await openPlan();

    await openDetailPanelFor("a1");

    fireEvent.click(screen.getByLabelText("Delete item"));

    await waitFor(() => expect(wbsApi.removeItem).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(rowIds()).toEqual(["a", "b"]));
  });

  it("reports the failure and keeps the row when deletion is rejected", async () => {
    vi.mocked(wbsApi.removeItem).mockRejectedValueOnce(new Error("item is locked"));
    renderPage();
    await openPlan();

    await openDetailPanelFor("a1");
    fireEvent.click(screen.getByLabelText("Delete item"));

    await waitFor(() => expect(screen.getByText("item is locked")).toBeTruthy());
    expect(rowIds()).toEqual(["a", "a1", "b"]);
  });
});

describe("WbsPage toolbar", () => {
  it("keeps 'Add child item' available only while an item is selected", async () => {
    vi.mocked(wbsApi.listItems).mockResolvedValue([]);
    renderPage();

    await waitFor(() => expect(screen.getByLabelText("Add root item")).toBeTruthy());
    expect((screen.getByLabelText("Add child item") as HTMLButtonElement).disabled).toBe(true);
    // Adding a root item needs a plan, not a selection.
    expect((screen.getByLabelText("Add root item") as HTMLButtonElement).disabled).toBe(false);
  });
});
