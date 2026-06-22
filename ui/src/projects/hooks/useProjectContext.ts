import { useCallback, useEffect, useState } from "react";
import { projectsApi } from "../../lib/api";
import type { ProjectContextPack } from "../../types/models";
import { useProjectAsyncGuard } from "./useProjectAsyncGuard";

export interface NormalizedProjectContext extends ProjectContextPack {
  memories: NonNullable<ProjectContextPack["memories"]>;
  indexEntries: NonNullable<ProjectContextPack["indexEntries"]>;
  relations: NonNullable<ProjectContextPack["relations"]>;
  links: NonNullable<ProjectContextPack["links"]>;
}

function normalizeContext(context: ProjectContextPack): NormalizedProjectContext {
  return {
    ...context,
    memories: context.memories ?? [],
    indexEntries: context.indexEntries ?? [],
    relations: context.relations ?? [],
    links: context.links ?? [],
    truncation: context.truncation ?? { maxChars: 12000, truncatedSections: [] }
  };
}

export function useProjectContext(projectId: string) {
  const [context, setContext] = useState<NormalizedProjectContext | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, isCurrentRequest, invalidateRequests } = useProjectAsyncGuard(projectId);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const request = beginRequest(projectId);
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await projectsApi.getContext(projectId, {
        include: ["brief", "summary", "memory", "index", "relations", "links"],
        memoryLimit: 10,
        indexLimit: 20,
        relationLimit: 10,
        maxChars: 12000
      });
      if (!isCurrentRequest(request)) return;
      setContext(normalizeContext(loaded));
    } catch (loadError) {
      if (!isCurrentRequest(request)) return;
      setError(loadError instanceof Error ? loadError.message : "Project context is unavailable.");
    } finally {
      if (isCurrentRequest(request)) setIsLoading(false);
    }
  }, [beginRequest, isCurrentRequest, projectId]);

  useEffect(() => {
    invalidateRequests();
    setContext(null);
    setError(null);
    void reload();
    return invalidateRequests;
  }, [invalidateRequests, reload]);

  const currentContext = context?.project.id === projectId ? context : null;
  return { context: currentContext, isLoading, error, reload };
}
