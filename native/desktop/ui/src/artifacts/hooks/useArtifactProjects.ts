import { useCallback, useEffect, useState } from "react";
import { artifactsApi, projectsApi } from "../../lib/api";
import type { ProjectRecord } from "../../types/models";
import type { ProjectOption } from "../types";
import { uniqueProjectOptions } from "../utils/tree";

export function useArtifactProjects(enabled = true) {
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [defaultProject, setDefaultProject] = useState<ProjectOption | null>(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const loadProjects = async () => {
      setProjectsLoaded(false);
      const defaultSelection = await projectsApi.getDefault().catch(() => null);
      const resolvedDefault: ProjectOption | null = defaultSelection && defaultSelection.project.status !== "archived"
        ? { projectId: defaultSelection.project.id, projectName: defaultSelection.project.name }
        : null;
      if (!cancelled) {
        setDefaultProject(resolvedDefault);
      }

      try {
        const all: ProjectRecord[] = [];
        let cursor: string | undefined;

        for (let page = 0; page < 20; page += 1) {
          const result = await projectsApi.list(undefined, undefined, 100, cursor);
          all.push(...result.items);
          if (!result.nextCursor) {
            break;
          }
          cursor = result.nextCursor;
        }

        const visibleProjects = all.filter((project) => project.status !== "archived");
        if (!cancelled) {
          setProjectOptions(uniqueProjectOptions(visibleProjects, resolvedDefault));
        }
      } catch {
        try {
          const fallback = await artifactsApi.projects();
          const fallbackOptions = fallback
            .map((project) => ({ projectId: project.projectId, projectName: project.projectName }))
            .sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
          const merged = new Map<string, ProjectOption>();
          if (resolvedDefault?.projectId) {
            merged.set(resolvedDefault.projectId, resolvedDefault);
          }
          for (const option of fallbackOptions) {
            merged.set(option.projectId, option);
          }
          if (!cancelled) {
            setProjectOptions([...merged.values()]);
          }
        } catch {
          // Notification is handled globally.
        }
      } finally {
        if (!cancelled) {
          setProjectsLoaded(true);
        }
      }
    };

    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadVersion]);

  return { projectOptions, defaultProject, projectsLoaded, reload };
}
