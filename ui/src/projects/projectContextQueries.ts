export interface ProjectMemoryQueryOptions {
  q?: string;
  kind?: string;
  authority?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface ProjectIndexQueryOptions {
  q?: string;
  sourceService?: string;
  resourceType?: string;
  limit?: number;
  cursor?: string;
}

function appendPageOptions(params: URLSearchParams, options?: { limit?: number; cursor?: string }) {
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
}

export function buildProjectMemoryQuery(options?: ProjectMemoryQueryOptions): string {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.kind) params.set("kind", options.kind);
  if (options?.authority) params.set("authority", options.authority);
  if (options?.status) params.set("status", options.status);
  appendPageOptions(params, options);
  return params.toString();
}

export function buildProjectIndexQuery(options?: ProjectIndexQueryOptions): string {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.sourceService) params.set("sourceService", options.sourceService);
  if (options?.resourceType) params.set("resourceType", options.resourceType);
  appendPageOptions(params, options);
  return params.toString();
}
