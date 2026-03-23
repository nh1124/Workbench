function requireViteEnv(name: "VITE_WORKBENCH_CORE_URL"): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const workbenchCoreUrl = requireViteEnv("VITE_WORKBENCH_CORE_URL");

export const navItems = [
  { path: "/", label: "Home" },
  { path: "/projects", label: "Project" },
  { path: "/tasks", label: "Tasks" },
  { path: "/notes", label: "Notes" },
  { path: "/research", label: "Research" },
  { path: "/artifacts", label: "Artifacts" }
] as const;
