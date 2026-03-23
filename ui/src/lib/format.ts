export function formatDateTime(input?: string): string {
  if (!input) {
    return "-";
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function normalizeProjectName(projectId: string, projectName?: string): string {
  return projectName?.trim() || projectId;
}
