import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { readRecentArtifacts, type RecentArtifact } from "../artifacts/utils/recents";
import { projectsApi, readWorkbenchSession, tasksApi } from "../lib/api";
import {
  getDefaultLocationPreset,
  getLocationPresetsForTimezone,
  loadUiSettings,
  type UiSettings
} from "../lib/uiSettings";
import type { Task, TaskProjectSummary, TodayTask } from "../types/models";
import "./HomePage.css";

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

type HomeIconName =
  | "arrow"
  | "calendar"
  | "check"
  | "cloud"
  | "file"
  | "folder"
  | "note"
  | "plus"
  | "tasks";

function HomeIcon({ name }: { name: HomeIconName }) {
  const paths: Record<HomeIconName, ReactNode> = {
    arrow: (
      <>
        <path d="M7 17 17 7" />
        <path d="M9 7h8v8" />
      </>
    ),
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M16.5 3v4M7.5 3v4M3.5 10h17" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    cloud: (
      <path d="M20 17.5a4 4 0 0 0-1.6-7.7 5.8 5.8 0 0 0-11.2 1.7A3.5 3.5 0 0 0 7.5 18H20z" />
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </>
    ),
    folder: <path d="M3 7h6l2 2h10v11H3z" />,
    note: (
      <>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h5M9 13h6" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    tasks: (
      <>
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M9 9h6M9 13h6M9 17h4" />
      </>
    )
  };

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function getGreeting(now: Date, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone
  }).format(now));
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function weatherCodeLabel(code: number | null): string {
  if (code === null) return "Unavailable";
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
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

function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatRecentArtifactTime(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function artifactLink(item: RecentArtifact): string {
  return `/artifacts?item=${encodeURIComponent(item.itemId)}`;
}

function resolveCoordinates(settings: UiSettings): { latitude: number; longitude: number } {
  if (
    typeof settings.locationLatitude === "number"
    && typeof settings.locationLongitude === "number"
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

function taskTimeLabel(task: TodayTask): string {
  if (task.startTime && task.endTime) return `${task.startTime}–${task.endTime}`;
  return task.startTime || "Anytime";
}

export function HomePage() {
  const navigate = useNavigate();
  const currentUser = readWorkbenchSession();
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [todayTasks, setTodayTasks] = useState<TodayTask[]>([]);
  const [taskProjects, setTaskProjects] = useState<TaskProjectSummary[]>([]);
  const [projectNameMap, setProjectNameMap] = useState<Map<string, string>>(new Map());
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
  const [recentArtifacts, setRecentArtifacts] = useState<RecentArtifact[]>(() => readRecentArtifacts(5));
  const weatherPanelRef = useRef<HTMLDivElement | null>(null);
  const todayKey = formatDateKeyInTimeZone(now, settings.timezone);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);

      try {
        const [tasks, today, projects, projectList] = await Promise.all([
          tasksApi.list(undefined, undefined, 200),
          tasksApi.todayList(todayKey),
          tasksApi.projects(),
          projectsApi.list(undefined, "active", 200).catch(() => ({ items: [] }))
        ]);
        if (cancelled) return;
        setAllTasks(tasks);
        setTodayTasks(today);
        setTaskProjects(projects);

        const nameMap = new Map<string, string>();
        for (const project of projectList.items) {
          if (project.name?.trim()) nameMap.set(project.id, project.name.trim());
        }
        setProjectNameMap(nameMap);
      } catch {
        // API errors are routed to the global notification center.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [todayKey]);

  useEffect(() => {
    const reloadSettings = () => setSettings(loadUiSettings());
    window.addEventListener("storage", reloadSettings);
    window.addEventListener("workbench-ui-settings-changed", reloadSettings);
    return () => {
      window.removeEventListener("storage", reloadSettings);
      window.removeEventListener("workbench-ui-settings-changed", reloadSettings);
    };
  }, []);

  useEffect(() => {
    const reloadRecentArtifacts = () => setRecentArtifacts(readRecentArtifacts(5));
    window.addEventListener("storage", reloadRecentArtifacts);
    window.addEventListener("workbench-recent-artifacts-changed", reloadRecentArtifacts);
    return () => {
      window.removeEventListener("storage", reloadRecentArtifacts);
      window.removeEventListener("workbench-recent-artifacts-changed", reloadRecentArtifacts);
    };
  }, []);

  useEffect(() => {
    const closeWeather = (event: MouseEvent) => {
      if (!weatherPanelRef.current?.contains(event.target as Node)) setIsWeatherOpen(false);
    };
    const closeWeatherWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsWeatherOpen(false);
    };
    document.addEventListener("mousedown", closeWeather);
    document.addEventListener("keydown", closeWeatherWithEscape);
    return () => {
      document.removeEventListener("mousedown", closeWeather);
      document.removeEventListener("keydown", closeWeatherWithEscape);
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
        if (!response.ok) throw new Error("Weather request failed");

        const payload = await response.json() as {
          current?: { temperature_2m?: number; weather_code?: number };
          hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] };
        };
        if (cancelled) return;

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
        const hourly = hourlyTimes
          .map((time, index) => {
            const parsed = new Date(time);
            if (Number.isNaN(parsed.getTime()) || parsed.getTime() < nowTs - 5 * 60 * 1000) return null;
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
              temperatureLabel: hourlyTemp === null ? "--°" : `${hourlyTemp}°`
            };
          })
          .filter((entry): entry is WeatherSnapshot["hourly"][number] => Boolean(entry))
          .slice(0, 6);

        setWeather({
          summary: weatherCodeLabel(code),
          temperatureC: temperature,
          hourly,
          updatedAt: new Date().toISOString()
        });
      } catch {
        if (!cancelled) {
          setWeather({ summary: "Unavailable", temperatureC: null, hourly: [], updatedAt: "" });
        }
      }
    };

    void loadWeather();
    const timer = window.setInterval(() => void loadWeather(), 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings]);

  const progressRows = useMemo<ProjectProgressRow[]>(() => {
    return taskProjects
      .map((project) => {
        const projectTasks = allTasks.filter((task) => task.context === project.projectId);
        const doneTasks = projectTasks.filter((task) => task.status === "done").length;
        const totalTasks = projectTasks.length;
        const registeredName = projectNameMap.get(project.projectId);
        const rawContextName = project.projectName?.trim()
          || projectTasks.find((task) => task.contextName?.trim())?.contextName?.trim();
        const contextName = rawContextName && !isLikelyIdentifier(rawContextName) ? rawContextName : undefined;

        return {
          projectId: project.projectId,
          projectName: registeredName || contextName || `Project ${project.projectId.slice(0, 8)}`,
          totalTasks,
          doneTasks,
          completion: totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100)
        };
      })
      .filter((project) => project.totalTasks > 0)
      .sort((a, b) => b.totalTasks - a.totalTasks)
      .slice(0, 4);
  }, [allTasks, taskProjects, projectNameMap]);

  const sortedTodayTasks = useMemo(() => {
    return [...todayTasks].sort((a, b) => {
      const statusRank = (task: TodayTask) => task.status === "todo" ? 0 : 1;
      const statusDiff = statusRank(a) - statusRank(b);
      if (statusDiff !== 0) return statusDiff;
      const timeDiff = (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
      if (timeDiff !== 0) return timeDiff;
      return a.title.localeCompare(b.title);
    });
  }, [todayTasks]);

  const remainingTodayCount = sortedTodayTasks.filter((task) => task.status === "todo").length;
  const primaryTask = sortedTodayTasks.find((task) => task.status === "todo");
  const nextTasks = sortedTodayTasks.filter((task) => task.id !== primaryTask?.id).slice(0, 4);

  const projectNameForTask = (task: TodayTask): string => {
    const registeredName = projectNameMap.get(task.context);
    if (registeredName) return registeredName;
    if (task.contextName?.trim() && !isLikelyIdentifier(task.contextName)) return task.contextName.trim();
    return task.context ? `Project ${task.context.slice(0, 8)}` : "Inbox";
  };

  const openTask = (task: TodayTask) => {
    navigate("/tasks", {
      state: {
        openTaskId: task.id,
        occurrenceStatus: task.status,
        occurrenceDate: task.occurrenceDate,
        scheduleId: task.scheduleId,
        scheduledDate: task.scheduledDate
      }
    });
  };

  if (isLoading) {
    return <div className="home-loading" aria-label="Loading Home"><span /></div>;
  }

  const weatherTemperature = weather.temperatureC === null ? "--°" : `${weather.temperatureC}°`;

  return (
    <section className="home-shell">
      <header className="home-focus-header">
        <div className="home-heading">
          <p>
            {now.toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
              timeZone: settings.timezone
            })}
          </p>
          <h2>{getGreeting(now, settings.timezone)}, {currentUser?.username ?? ""}.</h2>
        </div>

        <div className="home-header-actions">
          <div className="home-weather-wrap" ref={weatherPanelRef}>
            <button
              type="button"
              className="home-weather-button"
              aria-label={`${weather.summary}, ${weatherTemperature}`}
              aria-expanded={isWeatherOpen}
              onClick={() => setIsWeatherOpen((open) => !open)}
            >
              <HomeIcon name="cloud" />
              <span>{weather.summary}</span>
              <strong>{weatherTemperature}</strong>
            </button>
            {isWeatherOpen ? (
              <div className="home-weather-popover" role="dialog" aria-label="Hourly weather">
                {weather.hourly.length === 0 ? (
                  <p>No forecast</p>
                ) : weather.hourly.map((item) => (
                  <div key={`${item.timeLabel}-${item.summary}`} className="home-weather-hour">
                    <strong>{item.timeLabel}</strong>
                    <span>{item.summary}</span>
                    <em>{item.temperatureLabel}</em>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="home-quick-note"
            aria-label="Quick note"
            onClick={() => navigate("/artifacts?new=note")}
          >
            <HomeIcon name="plus" />
            <span>Quick note</span>
          </button>
        </div>
      </header>

      <div className="home-focus-grid">
        <main className="home-today-column">
          <div className="home-section-heading">
            <div>
              <p>Today</p>
              <h3>Your focus</h3>
            </div>
            <span>{remainingTodayCount} remaining</span>
          </div>

          {primaryTask ? (
            <article className="home-primary-task">
              <div className="home-primary-meta">
                <span>Now</span>
                <p>{projectNameForTask(primaryTask)} · {taskTimeLabel(primaryTask)}</p>
              </div>
              <h3>{primaryTask.title}</h3>
              <div className="home-primary-actions">
                <button type="button" onClick={() => openTask(primaryTask)}>
                  <HomeIcon name="tasks" />
                  Open task
                </button>
                <Link to="/tasks">All tasks</Link>
              </div>
            </article>
          ) : (
            <article className="home-primary-task is-clear">
              <span className="home-clear-icon"><HomeIcon name="check" /></span>
              <h3>You're clear today.</h3>
              <Link to="/tasks">Open Tasks</Link>
            </article>
          )}

          {nextTasks.length > 0 ? (
            <div className="home-next-list">
              {nextTasks.map((task) => (
                <button
                  type="button"
                  key={`${task.id}-${task.occurrenceDate}-${task.scheduledDate}`}
                  className={task.status === "todo" ? "home-next-row" : "home-next-row is-done"}
                  onClick={() => openTask(task)}
                >
                  <span className="home-task-state" aria-hidden="true">
                    {task.status === "done" ? <HomeIcon name="check" /> : null}
                  </span>
                  <span className="home-next-copy">
                    <strong>{task.title}</strong>
                    <small>{projectNameForTask(task)}</small>
                  </span>
                  <time>{task.status === "done" ? "Done" : taskTimeLabel(task)}</time>
                </button>
              ))}
            </div>
          ) : null}
        </main>

        <aside className="home-support-column">
          <section className="home-panel">
            <div className="home-panel-heading">
              <div>
                <p>Projects</p>
                <h3>Momentum</h3>
              </div>
              <Link to="/projects" aria-label="Open Projects"><HomeIcon name="arrow" /></Link>
            </div>

            <div className="home-project-list">
              {progressRows.length === 0 ? (
                <p className="home-empty">No active projects</p>
              ) : progressRows.map((project) => (
                <div className="home-project-row" key={project.projectId}>
                  <div className="home-project-copy">
                    <strong>{project.projectName}</strong>
                    <small>{project.doneTasks}/{project.totalTasks}</small>
                  </div>
                  <div
                    className="home-progress-track"
                    role="progressbar"
                    aria-label={`${project.projectName} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={project.completion}
                  >
                    <span style={{ width: `${project.completion}%` }} />
                  </div>
                  <b>{project.completion}%</b>
                </div>
              ))}
            </div>
          </section>

          <section className="home-panel">
            <div className="home-panel-heading">
              <div>
                <p>Continue</p>
                <h3>Recent work</h3>
              </div>
              <Link to="/artifacts" aria-label="Open Artifacts"><HomeIcon name="arrow" /></Link>
            </div>

            <div className="home-recent-list">
              {recentArtifacts.length === 0 ? (
                <p className="home-empty">No recent work</p>
              ) : recentArtifacts.map((item) => (
                <Link className="home-recent-row" key={item.itemId} to={artifactLink(item)}>
                  <span className="home-recent-icon">
                    <HomeIcon name={item.kind === "note" ? "note" : "file"} />
                  </span>
                  <span className="home-recent-copy">
                    <strong>{item.title}</strong>
                    <small>{item.path || "/"}</small>
                  </span>
                  <time dateTime={item.at}>{formatRecentArtifactTime(item.at, now)}</time>
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
