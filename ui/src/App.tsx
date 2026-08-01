import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { HomePage } from "./pages/HomePage";
import { ImagesPage } from "./pages/ImagesPage";
import { AnalyserPage } from "./pages/AnalyserPage";
import { LoginPage } from "./pages/LoginPage";
import { MindmapsPage } from "./pages/MindmapsPage";
import { NotesPage } from "./pages/NotesPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { QuickNoteWindowPage } from "./pages/QuickNoteWindowPage";
import { ResearchPage } from "./pages/ResearchPage";
import { RegisterPage } from "./pages/RegisterPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ShortcutsPage } from "./pages/ShortcutsPage";
import { TasksPage } from "./pages/TasksPage";
import { TasksCalendarWindowPage } from "./pages/TasksCalendarWindowPage";
import { VariantShell } from "./components/VariantShell";
import { VariantChromeProvider } from "./components/VariantChrome";
import { VariantTitleBar, variantAppName } from "./components/VariantTitleBar";
import { WbsPage } from "./pages/WbsPage";

const variantStartPages: Record<string, string> = {
  tasks: "/tasks",
  notes: "/notes",
  artifacts: "/artifacts"
};

/**
 * Resolves the start page for a variant native app (Workbench Tasks / Notes / Artifacts).
 * Returns null for the main app and for missing or unknown values.
 */
export function resolveVariantStartPage(variant: string | null | undefined): string | null {
  if (!variant || variant === "main") return null;
  return variantStartPages[variant] ?? null;
}

function resolveStartPage(): string {
  try {
    const raw = localStorage.getItem("workbench-ui-settings");
    if (!raw) {
      return "/";
    }

    const parsed = JSON.parse(raw) as { startPage?: string };
    if (parsed.startPage === "/maintenance") {
      return "/analyser";
    }

    const allowed = new Set(["/", "/projects", "/analyser", "/tasks", "/notes", "/research", "/images", "/mindmaps", "/wbs", "/artifacts"]);
    if (parsed.startPage && allowed.has(parsed.startPage)) {
      return parsed.startPage;
    }

    return "/";
  } catch {
    return "/";
  }
}

export default function App() {
  if (typeof window !== "undefined") {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("quick-note-window") === "1") {
      return <QuickNoteWindowPage />;
    }
  }

  const variant = typeof window === "undefined" ? undefined : window.__WORKBENCH_VARIANT__;
  const variantStartPage = resolveVariantStartPage(variant);
  const startPage = variantStartPage ?? resolveStartPage();
  // A dedicated app launches into one feature, so it drops the cross-feature chrome.
  const isVariantApp = variantStartPage !== null;
  const shell = isVariantApp ? <VariantShell /> : <Layout />;
  const appName = variantAppName(variant);

  const routes = (
    <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/tasks/calendar" element={<TasksCalendarWindowPage />} />

        <Route path="/" element={shell}>
          <Route index element={startPage === "/" ? <HomePage /> : <Navigate to={startPage} replace />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="analyser" element={<AnalyserPage />} />
          <Route path="maintenance" element={<Navigate to="/analyser" replace />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="notes" element={<NotesPage />} />
          <Route path="research" element={<ResearchPage />} />
          <Route path="images" element={<ImagesPage />} />
          <Route path="mindmaps" element={<MindmapsPage />} />
          <Route path="wbs" element={<WbsPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="shortcuts" element={<ShortcutsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
  );

  return (
    <BrowserRouter>
      {isVariantApp ? (
        // The window is undecorated in a dedicated app, so the title bar has to exist on
        // every route — including the sign-in page, which lives outside the shell. Without
        // it that window could not be moved or closed.
        <VariantChromeProvider>
          <div className="variant-window">
            <VariantTitleBar appName={appName} />
            {routes}
          </div>
        </VariantChromeProvider>
      ) : (
        routes
      )}
    </BrowserRouter>
  );
}

