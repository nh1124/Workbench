// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksSecondarySidebar } from "../components/TasksSecondarySidebar";

function buildProps(): ComponentProps<typeof TasksSecondarySidebar> {
  return {
    sidebarMode: "calendar",
    setSidebarMode: vi.fn(),
    quickFilter: "today",
    setQuickFilter: vi.fn(),
    counters: { today: 0, myday: 0, planned: 0, overdue: 0, inbox: 0 },
    contextFilter: "",
    setContextFilter: vi.fn(),
    projectOptions: [],
    calendarStatusFilter: "all",
    setCalendarStatusFilter: vi.fn(),
    calendarMode: "month",
    onOpenCalendarWindow: vi.fn(),
  };
}

describe("TasksSecondarySidebar localization", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the detached-window menu in English under default settings", () => {
    render(<TasksSecondarySidebar {...buildProps()} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Due Calendar" }));

    expect(screen.getByRole("button", { name: "Open in a new window" })).toBeTruthy();
  });
});
