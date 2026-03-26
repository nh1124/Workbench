import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { projectsApi, readWorkbenchSession, tasksApi } from "../lib/api";
import {
  getDefaultLocationPreset,
  getLocationPresetsForTimezone,
  loadUiSettings,
  type UiSettings
} from "../lib/uiSettings";
import type { Task, TaskProjectSummary, TaskScheduleDay, TaskStatus } from "../types/models";
import "./HomePage.css";

interface CalendarCell {
  key: string;
  date: Date;
  inCurrentMonth: boolean;
}

interface ProjectProgressRow {
  projectId: string;
  projectName: string;
  totalTasks: number;
  doneTasks: number;
  completion: number;
}

interface WeatherSnapshot {
  summary: string;
  temperatureC: number | null;
  hourly: Array<{
    timeLabel: string;
    summary: string;
    temperatureLabel: string;
  }>;
  updatedAt: string;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function weatherCodeLabel(code: number | null): string {
  if (code === null) return "Unavailable";
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly Cloudy";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 99) return "Thunder";
  return "Cloudy";
}

function isLikelyIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const opaqueIdPattern = /^[a-z0-9_-]{16,}$/i;
  return uuidPattern.test(trimmed) || opaqueIdPattern.test(trimmed);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return startOfDay(parsed);
}

function taskWithinActivePeriod(task: Task, date: Date): boolean {
  if (task.recurrence === "ONCE") return true;
  if (task.active === false) return false;
  const from = parseDateOnly(task.activeFrom);
  const until = parseDateOnly(task.activeUntil);
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
}

function taskOccursOnDate(task: Task, date: Date): boolean {
  const day = startOfDay(date);

  if (task.recurrence === "ONCE") {
    const due = parseDateOnly(task.dueDate);
    return !!due && isSameDay(due, day);
  }

  if (!taskWithinActivePeriod(task, day)) return false;

  if (task.recurrence === "WEEKLY") {
    const selectedDays = [task.sun, task.mon, task.tue, task.wed, task.thu, task.fri, task.sat].map(Boolean);
    if (selectedDays.some(Boolean)) return selectedDays[day.getDay()];
    const fallback = parseDateOnly(task.activeFrom) || parseDateOnly(task.dueDate);
    return fallback ? fallback.getDay() === day.getDay() : false;
  }

  if (task.recurrence === "EVERY_N_DAYS") {
    const interval = Math.max(1, task.intervalDays ?? 1);
    const anchor = parseDateOnly(task.activeFrom) || parseDateOnly(task.createdAt);
    if (!anchor) return false;
    const diff = Math.floor((day.getTime() - anchor.getTime()) / DAY_MS);
    return diff >= 0 && diff % interval === 0;
  }

  if (task.recurrence === "MONTHLY_DAY") {
    const dayOfMonth = Math.min(31, Math.max(1, task.monthDay ?? 1));
    return day.getDate() === dayOfMonth;
  }

  if (task.recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nthInMonth = Math.min(5, Math.max(1, task.nthInMonth ?? 1));
    const weekday = Math.min(6, Math.max(0, task.weekdayMon1 ?? 0));
    const weekIndex = Math.floor((day.getDate() - 1) / 7) + 1;
    return day.getDay() === weekday && weekIndex === nthInMonth;
  }

  return false;
}

function resolveCoordinates(settings: UiSettings): { latitude: number; longitude: number } {
  if (
    typeof settings.locationLatitude === "number" &&
    typeof settings.locationLongitude === "number"
  ) {
    return {
      latitude: settings.locationLatitude,
      longitude: settings.locationLongitude
    };
  }

  if (settings.locationMode === "preset") {
    const preset = getLocationPresetsForTimezone(settings.timezone).find(
      (location) => location.id === settings.locationPresetId
    );
    if (preset) {
      return { latitude: preset.latitude, longitude: preset.longitude };
    }
  }

  const fallback = getDefaultLocationPreset(settings.timezone);
  return { latitude: fallback.latitude, longitude: fallback.longitude };
}

function toTaskStatus(value: string | undefined): TaskStatus {
  if (value === "done" || value === "skipped") return value;
  return "todo";
}

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildMonthCells(monthDate: Date): CalendarCell[] {
  const first = startOfMonth(monthDate);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const cells: CalendarCell[] = [];

  for (let i = 0; i < firstWeekday; i += 1) {
    const date = new Date(first.getFullYear(), first.getMonth(), i - firstWeekday + 1);
    cells.push({ key: `prev-${i}`, date, inCurrentMonth: false });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(first.getFullYear(), first.getMonth(), day);
    cells.push({ key: `cur-${day}`, date, inCurrentMonth: true });
  }

  while (cells.length % 7 !== 0 || cells.length < 35) {
    const nextIndex = cells.length - (firstWeekday + daysInMonth) + 1;
    const date = new Date(first.getFullYear(), first.getMonth() + 1, nextIndex);
    cells.push({ key: `next-${nextIndex}`, date, inCurrentMonth: false });
  }

  return cells;
}

export function HomePage() {
  const navigate = useNavigate();
  const currentUser = readWorkbenchSession();
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [taskProjects, setTaskProjects] = useState<TaskProjectSummary[]>([]);
  const [projectNameMap, setProjectNameMap] = useState<Map<string, string>>(new Map());
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [now, setNow] = useState(() => new Date());
  const [settings, setSettings] = useState<UiSettings>(() => loadUiSettings());
  const [weather, setWeather] = useState<WeatherSnapshot>({
    summary: "Syncing",
    temperatureC: null,
    hourly: [],
    updatedAt: ""
  });
  const [isWeatherOpen, setIsWeatherOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [calendarStatusMap, setCalendarStatusMap] = useState<Map<string, Map<string, TaskStatus>>>(new Map());
  const weatherPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);

      try {
        const [tasks, projects, projectList] = await Promise.all([
          tasksApi.list(undefined, undefined, 200),
          tasksApi.projects(),
          projectsApi.list(undefined, "active", 200).catch(() => ({ items: [] }))
        ]);
        setAllTasks(tasks);
        setTaskProjects(projects);
        const nameMap = new Map<string, string>();
        for (const rec of projectList.items) {
          if (rec.name?.trim()) nameMap.set(rec.id, rec.name.trim());
        }
        setProjectNameMap(nameMap);
      } catch {
        // API errors are routed to the global notification center.
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadSchedule = async () => {
      // Compute the full date range visible in the calendar grid for this month
      const year = monthCursor.getFullYear();
      const month = monthCursor.getMonth();
      const firstOfMonth = new Date(year, month, 1);
      const startOffset = firstOfMonth.getDay();
      const rangeStart = new Date(year, month, 1 - startOffset);
      const lastOfMonth = new Date(year, month + 1, 0);
      const endOffset = 6 - lastOfMonth.getDay();
      const rangeEnd = new Date(year, month + 1, endOffset);

      try {
        const scheduleDays = await tasksApi.schedule(formatDateKey(rangeStart), formatDateKey(rangeEnd));
        if (cancelled) return;

        const csMap = new Map<string, Map<string, TaskStatus>>();
        for (const day of scheduleDays) {
          for (const item of day.tasks) {
            if (!csMap.has(day.date)) csMap.set(day.date, new Map());
            csMap.get(day.date)!.set(item.taskId, toTaskStatus(item.status));
          }
        }
        setCalendarStatusMap(csMap);
      } catch {
        // schedule fetch failure is non-critical; statuses fall back to master task status
      }
    };

    void loadSchedule();
    return () => { cancelled = true; };
  }, [monthCursor]);

  useEffect(() => {
    const reloadSettings = () => {
      setSettings(loadUiSettings());
    };

    window.addEventListener("storage", reloadSettings);
    window.addEventListener("workbench-ui-settings-changed", reloadSettings);

    return () => {
      window.removeEventListener("storage", reloadSettings);
      window.removeEventListener("workbench-ui-settings-changed", reloadSettings);
    };
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!weatherPanelRef.current?.contains(event.target as Node)) {
        setIsWeatherOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsWeatherOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadWeather = async () => {
      try {
        const { latitude, longitude } = resolveCoordinates(settings);
        const timezone = encodeURIComponent(settings.timezone);
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&forecast_days=2&timezone=${timezone}`
        );

        if (!response.ok) {
          throw new Error("Weather request failed");
        }

        const payload = await response.json() as {
          current?: {
            temperature_2m?: number;
            weather_code?: number;
          };
          hourly?: {
            time?: string[];
            temperature_2m?: number[];
            weather_code?: number[];
          };
        };

        if (cancelled) {
          return;
        }

        const temperature = typeof payload.current?.temperature_2m === "number"
          ? Math.round(payload.current.temperature_2m)
          : null;
        const code = typeof payload.current?.weather_code === "number"
          ? payload.current.weather_code
          : null;
        const hourlyTimes = payload.hourly?.time ?? [];
        const hourlyTemps = payload.hourly?.temperature_2m ?? [];
        const hourlyCodes = payload.hourly?.weather_code ?? [];
        const nowTs = Date.now();

        const forecastItems = hourlyTimes
          .map((time, index) => {
            const parsed = new Date(time);
            if (Number.isNaN(parsed.getTime())) {
              return null;
            }
            if (parsed.getTime() < nowTs - 5 * 60 * 1000) {
              return null;
            }

            const hourlyTemp = typeof hourlyTemps[index] === "number" ? Math.round(hourlyTemps[index]) : null;
            const hourlyCode = typeof hourlyCodes[index] === "number" ? hourlyCodes[index] : null;
            return {
              timeLabel: parsed.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: settings.timezone
              }),
              summary: weatherCodeLabel(hourlyCode),
              temperatureLabel: hourlyTemp === null ? "--°C" : `${hourlyTemp}°C`
            };
          })
          .filter((entry): entry is { timeLabel: string; summary: string; temperatureLabel: string } => Boolean(entry))
          .slice(0, 12);

        setWeather({
          summary: weatherCodeLabel(code),
          temperatureC: temperature,
          hourly: forecastItems,
          updatedAt: new Date().toISOString()
        });
      } catch {
        if (!cancelled) {
          setWeather({
            summary: "Unavailable",
            temperatureC: null,
            hourly: [],
            updatedAt: new Date().toISOString()
          });
        }
      }
    };

    void loadWeather();
    const timer = window.setInterval(() => {
      void loadWeather();
    }, 10 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings]);

  const remainingTasks = useMemo(() => allTasks.filter((task) => task.status !== "done").length, [allTasks]);

  const progressRows = useMemo<ProjectProgressRow[]>(() => {
    return taskProjects
      .map((project) => {
        const projectTasks = allTasks.filter((task) => task.context === project.projectId);
        const doneTasks = projectTasks.filter((task) => task.status === "done").length;
        const totalTasks = projectTasks.length;
        const completion = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);

        // Priority: projectsApi name > non-identifier contextName > short project ID prefix
        const registeredName = projectNameMap.get(project.projectId);
        const rawContextName = project.projectName?.trim() || projectTasks.find((task) => task.contextName?.trim())?.contextName?.trim();
        const contextName = rawContextName && !isLikelyIdentifier(rawContextName) ? rawContextName : undefined;
        const displayName = registeredName || contextName || `Project ${project.projectId.slice(0, 8)}`;

        return {
          projectId: project.projectId,
          projectName: displayName,
          totalTasks,
          doneTasks,
          completion
        };
      })
      .sort((a, b) => b.totalTasks - a.totalTasks)
      .slice(0, 6);
  }, [allTasks, taskProjects, projectNameMap]);

  const monthCells = useMemo(() => buildMonthCells(monthCursor), [monthCursor]);

  const tasksByDay = useMemo(() => {
    const visibleDates = monthCells.map((cell) => startOfDay(cell.date));
    const map = new Map<string, Task[]>();

    for (const date of visibleDates) {
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const dateKey = formatDateKey(date);
      const dateStatuses = calendarStatusMap.get(dateKey);
      map.set(
        key,
        allTasks
          .filter((task) => taskOccursOnDate(task, date))
          .map((task) => {
            const status = dateStatuses?.get(task.id);
            return status !== undefined ? { ...task, status } : task;
          })
      );
    }

    return map;
  }, [allTasks, monthCells, calendarStatusMap]);

  if (isLoading) {
    return <p className="info">Loading dashboard...</p>;
  }

  const weatherTemperature = weather.temperatureC === null ? "--°C" : `${weather.temperatureC}°C`;
  const locationLabel = settings.locationMode === "auto" ? settings.location : settings.location;

  return (
    <section className="home-shell">
      <article className="hero-card">
        <div className="hero-main">
          <p className="hero-greeting">{getGreeting(now)},</p>
          <h2 className="hero-name">{currentUser?.username ?? ""}</h2>
          <p className="hero-sub">
            <svg className="hero-sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="8" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {remainingTasks} tasks remaining
          </p>
        </div>

        <div className="hero-time-box" ref={weatherPanelRef}>
          <div className="hero-time-main">
            <strong>{now.toLocaleTimeString("ja-JP", { hour12: false, timeZone: settings.timezone })}</strong>
            <span>{now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: settings.timezone })}</span>
            <span className="hero-time-separator" aria-hidden="true" />
            <button
              type="button"
              className="hero-weather"
              aria-label={`Weather ${weather.summary} ${weatherTemperature}`}
              aria-expanded={isWeatherOpen}
              onClick={() => setIsWeatherOpen((prev) => !prev)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M20 17.5a4 4 0 0 0-1.6-7.7 5.8 5.8 0 0 0-11.2 1.7A3.5 3.5 0 0 0 7.5 18H20z" />
              </svg>
              <span>{weather.summary}</span>
              <strong>{weatherTemperature}</strong>
            </button>
          </div>
          <small>{locationLabel} / SYNCING</small>

          {isWeatherOpen ? (
            <div className="hero-weather-popover" role="dialog" aria-label="Hourly weather forecast">
              <div className="hero-weather-popover-head">
                <strong>Next 12 Hours</strong>
                <span>
                  {weather.updatedAt
                    ? `Updated ${new Date(weather.updatedAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                      timeZone: settings.timezone
                    })}`
                    : ""}
                </span>
              </div>
              <div className="hero-weather-popover-list">
                {weather.hourly.length === 0 ? (
                  <p>No hourly forecast available.</p>
                ) : weather.hourly.map((item) => (
                  <div key={`${item.timeLabel}-${item.summary}`} className="hero-weather-hour">
                    <strong>{item.timeLabel}</strong>
                    <span>{item.summary}</span>
                    <em>{item.temperatureLabel}</em>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </article>

      <div className="home-main-grid">
        <article className="panel home-panel home-panel-progress">
          <div className="panel-heading compact">
            <div className="panel-title-group">
              <span className="panel-title-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
                  <path d="M9 4.5v15M4.5 10h15" />
                </svg>
              </span>
              <h3>Project Progress</h3>
            </div>
            <Link to="/tasks" className="panel-jump-link">
              <span>Open Tasks</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M7 17L17 7" />
                <path d="M9 7h8v8" />
              </svg>
            </Link>
          </div>

          <div className="progress-list">
            {progressRows.length === 0 ? (
              <p className="progress-empty">No projects yet</p>
            ) : progressRows.map((row) => (
              <div key={row.projectId} className="progress-row">
                <div className="progress-meta">
                  <div className="progress-title">
                    <span className="progress-dot" aria-hidden="true" />
                    <strong>{row.projectName}</strong>
                  </div>
                  <small>
                    {row.doneTasks}/{row.totalTasks} <span className="progress-rate">{row.completion}%</span>
                  </small>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${row.completion}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel home-panel home-panel-calendar">
          <div className="panel-heading compact">
            <div className="panel-title-group">
              <span className="panel-title-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
                  <path d="M16.5 3v4M7.5 3v4M3.5 10h17" />
                </svg>
              </span>
              <h3>Calendar</h3>
            </div>
            <div className="month-nav">
              <button
                type="button"
                className="icon-button"
                onClick={() => setMonthCursor((prev) => addMonths(prev, -1))}
                aria-label="Previous month"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <strong>
                {monthCursor.toLocaleDateString("en-US", { year: "numeric", month: "long" })}
              </strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => setMonthCursor((prev) => addMonths(prev, 1))}
                aria-label="Next month"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </div>

          <div className="mini-calendar-wrap">
            <div className="mini-calendar-weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="mini-calendar-grid">
              {monthCells.map((cell) => {
                const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
                const dayTasks = tasksByDay.get(key) || [];
                const isToday = isSameDay(cell.date, now);

                return (
                  <div
                    key={cell.key}
                    className={[
                      "mini-calendar-cell",
                      cell.inCurrentMonth ? "is-current" : "is-muted",
                      isToday ? "is-today" : ""
                    ].filter(Boolean).join(" ")}
                  >
                    <span>{cell.date.getDate()}</span>
                    {dayTasks.slice(0, 2).map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className={`mini-calendar-task${task.status === "done" ? " done" : ""}`}
                        onClick={(e) => { e.stopPropagation(); navigate("/tasks", { state: { openTaskId: task.id, occurrenceStatus: task.status } }); }}
                      >
                        {task.title}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}



