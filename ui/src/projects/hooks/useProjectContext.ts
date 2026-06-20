import { useCallback, useEffect, useState } from "react";
import { projectsApi } from "../../lib/api";
import type { ProjectContextPack } from "../../types/models";

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

  const reload = useCallback(async () => {
    if (!projectId) return;
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
      setContext(normalizeContext(loaded));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Project context is unavailable.");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setContext(null);
    void reload();
  }, [reload]);

  return { context, isLoading, error, reload };
}
