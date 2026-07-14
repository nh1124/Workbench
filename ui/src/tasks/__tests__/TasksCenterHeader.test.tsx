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
  it("shows Today, Due, and Schedule without calendar mode buttons in Today", () => {
    const onSetStandaloneView = vi.fn();
    render(<TasksCenterHeader {...buildProps({ onSetStandaloneView })} />);

    const viewToggle = screen.getByLabelText("Task view");
    expect(within(viewToggle).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Today", "Due", "Schedule"]);
    expect(screen.queryByLabelText("Month view")).toBeNull();
    expect(screen.queryByLabelText("Week view")).toBeNull();

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Due" }));
    expect(onSetStandaloneView).toHaveBeenCalledWith("calendar");
  });

  it("keeps month and week controls for calendar modes", () => {
    render(<TasksCenterHeader {...buildProps({ sidebarMode: "schedule" })} />);

    expect(screen.getByLabelText("Task view")).toBeTruthy();
    expect(screen.getByLabelText("Month view")).toBeTruthy();
    expect(screen.getByLabelText("Week view")).toBeTruthy();
  });
});
