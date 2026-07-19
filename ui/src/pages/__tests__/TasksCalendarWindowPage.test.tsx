// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksCalendarWindowPage } from "../TasksCalendarWindowPage";

const containerProps = vi.hoisted(() => vi.fn());

vi.mock("../../tasks/TasksPageContainer", () => ({
  TasksPageContainer: (props: unknown) => {
    containerProps(props);
    return <div data-testid="tasks-page-container" />;
  },
}));

function renderStandaloneRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TasksCalendarWindowPage />
    </MemoryRouter>
  );
}

describe("TasksCalendarWindowPage standalone mode", () => {
  beforeEach(() => {
    containerProps.mockClear();
    document.title = "Workbench";
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults the bare route to the Day list", () => {
    renderStandaloneRoute("/tasks/calendar");

    expect(containerProps).toHaveBeenLastCalledWith({
      standalone: true,
      initialSidebarMode: "list",
      initialCalendarMode: "month",
      initialDayDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(document.title).toBe("Workbench Tasks");
  });

  it("resolves an explicit Due week calendar", () => {
    renderStandaloneRoute("/tasks/calendar?calendar=due&view=week");

    expect(containerProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialSidebarMode: "calendar",
      initialCalendarMode: "week",
    }));
  });

  it("passes an explicit Day date to the container", () => {
    renderStandaloneRoute("/tasks/calendar?calendar=day&date=2026-07-18");

    expect(containerProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialSidebarMode: "list",
      initialCalendarMode: "month",
      initialDayDate: "2026-07-18",
    }));
  });

  it("resolves an explicit Schedule month calendar", () => {
    renderStandaloneRoute("/tasks/calendar?calendar=schedule&view=month");

    expect(containerProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialSidebarMode: "schedule",
      initialCalendarMode: "month",
    }));
  });

  it("accepts Today as a Day alias and ignores its view", () => {
    renderStandaloneRoute("/tasks/calendar?calendar=today&view=week&date=2026-07-19");

    expect(containerProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialSidebarMode: "list",
      initialCalendarMode: "month",
      initialDayDate: "2026-07-19",
    }));
  });
});
