import { projectsClient } from "./internalClients.js";
import { logger } from "./logger.js";

export function markIndexEntryReadBestEffort(input: {
  accessToken: string;
  sourceService: string;
  resourceId: string;
}): void {
  const sourceService = input.sourceService.trim();
  const resourceId = input.resourceId.trim();
  if (!sourceService || !resourceId) return;

  void projectsClient.markIndexEntriesRead(input.accessToken, {
    marks: [{ sourceService, resourceId }]
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[usage] failed to mark index entry read", { sourceService, resourceId, message });
  });
}
