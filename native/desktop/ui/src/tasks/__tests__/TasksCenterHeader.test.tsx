// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksCenterHeader } from "../components/TasksCenterHeader";

function buildProps(
  overrides: Partial<ComponentProps<typeof TasksCenterHeader>> = {}
): ComponentProps<typeof TasksCenterHeader> {
  return {
    sidebarMode: "list",
    calendarMode: "month",
    periodLabel: "July 2026",
    onMovePrevPeriod: vi.fn(),
    onJumpToday: vi.fn(),
    onMoveNextPeriod: vi.fn(),
    onSetCalendarMode: vi.fn(),
    onRefreshList: vi.fn(),
    onRefreshSchedule: vi.fn(),
    sortMode: "load",
    onSetSortMode: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    importRef: createRef<HTMLInputElement>(),
    onOpenAddPanel: vi.fn(),
    standalone: true,
    onSetStandaloneView: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("TasksCenterHeader standalone views", () => {
  it("shows Day navigation and keeps the view toggle at the far right", () => {
    const onSetStandaloneView = vi.fn();
    const onMovePrevPeriod = vi.fn();
    const onJumpToday = vi.fn();
    const onMoveNextPeriod = vi.fn();
    render(<TasksCenterHeader {...buildProps({
      onSetStandaloneView,
      onMovePrevPeriod,
      onJumpToday,
      onMoveNextPeriod,
      periodLabel: "Wednesday, July 15",
    })} />);

    const viewToggle = screen.getByLabelText("Task view");
    expect(within(viewToggle).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Day", "Due", "Schedule"]);
    expect(screen.queryByLabelText("Month view")).toBeNull();
    expect(screen.queryByLabelText("Week view")).toBeNull();
    expect(screen.getByText("Wednesday, July 15")).toBeTruthy();
    expect(viewToggle.parentElement?.lastElementChild).toBe(viewToggle);

    fireEvent.click(screen.getByLabelText("Previous day"));
    fireEvent.click(screen.getByLabelText("Jump to today"));
    fireEvent.click(screen.getByLabelText("Next day"));
    expect(onMovePrevPeriod).toHaveBeenCalledOnce();
    expect(onJumpToday).toHaveBeenCalledOnce();
    expect(onMoveNextPeriod).toHaveBeenCalledOnce();

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Due" }));
    expect(onSetStandaloneView).toHaveBeenCalledWith("calendar");
  });

  it("keeps month and week controls before the far-right view toggle", () => {
    render(<TasksCenterHeader {...buildProps({ sidebarMode: "schedule" })} />);

    const viewToggle = screen.getByLabelText("Task view");
    expect(viewToggle.parentElement?.lastElementChild).toBe(viewToggle);
    expect(screen.getByLabelText("Month view")).toBeTruthy();
    expect(screen.getByLabelText("Week view")).toBeTruthy();
  });

  it("hides export, import, refresh, and add chrome while retaining sort", () => {
    render(<TasksCenterHeader {...buildProps()} />);

    expect(screen.getByLabelText("Sort task list")).toBeTruthy();
    expect(screen.queryByLabelText("Export CSV")).toBeNull();
    expect(screen.queryByLabelText("Import CSV")).toBeNull();
    expect(screen.queryByLabelText("Refresh list")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add" })).toBeNull();
  });

  it("keeps the main list header chrome unchanged", () => {
    render(<TasksCenterHeader {...buildProps({ standalone: false })} />);

    expect(screen.getByLabelText("Export CSV")).toBeTruthy();
    expect(screen.getByLabelText("Import CSV")).toBeTruthy();
    expect(screen.getByLabelText("Refresh list")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add" })).toBeTruthy();
    expect(screen.queryByLabelText("Task view")).toBeNull();
  });
});
