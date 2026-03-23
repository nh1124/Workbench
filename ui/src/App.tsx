import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
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

function resolveStartPage(): string {
  try {
    const raw = localStorage.getItem("workbench-ui-settings");
    if (!raw) {
      return "/";
    }

    const parsed = JSON.parse(raw) as { startPage?: string };
    const allowed = new Set(["/", "/projects", "/tasks", "/notes", "/research", "/artifacts"]);
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

  const startPage = resolveStartPage();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route path="/" element={<Layout />}>
          <Route index element={startPage === "/" ? <HomePage /> : <Navigate to={startPage} replace />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="notes" element={<NotesPage />} />
          <Route path="research" element={<ResearchPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="shortcuts" element={<ShortcutsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

