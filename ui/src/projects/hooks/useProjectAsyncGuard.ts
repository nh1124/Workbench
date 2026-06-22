import { useCallback, useEffect, useRef } from "react";

export interface ProjectRequestToken {
  projectId: string;
  generation: number;
}

/**
 * Keeps async Project UI work scoped to the Project that started it.
 * A response is stale after a newer guarded request, a Project change, or unmount.
 */
export function useProjectAsyncGuard(projectId: string) {
  const currentProjectIdRef = useRef(projectId);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  currentProjectIdRef.current = projectId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const beginRequest = useCallback((requestedProjectId: string): ProjectRequestToken => ({
    projectId: requestedProjectId,
    generation: ++generationRef.current
  }), []);

  const isCurrentRequest = useCallback((token: ProjectRequestToken): boolean => (
    mountedRef.current
    && currentProjectIdRef.current === token.projectId
    && generationRef.current === token.generation
  ), []);

  const isCurrentProject = useCallback((requestedProjectId: string): boolean => (
    mountedRef.current && currentProjectIdRef.current === requestedProjectId
  ), []);

  const invalidateRequests = useCallback(() => {
    generationRef.current += 1;
  }, []);

  return { beginRequest, isCurrentRequest, isCurrentProject, invalidateRequests };
}
