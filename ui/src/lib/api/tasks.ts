import { getWorkbenchLocalRoutingMode } from "../../config/services";
import { pushErrorNotification } from "../notificationService";
import {
  CLIENT_OP_ID_HEADER,
  autoRoutingCanFallbackToLocal,
  coreBaseUrl,
  fetchTasksFacadeJson,
  fetchWithSessionAuth,
  fileToBase64,
  filenameFromDisposition,
  markSuccessfulCoreRequest,
  markSuccessfulLocalRequest,
  requestLocalDaemonJson,
  requestTasksFacade,
  tasksFacadeEnabled
} from "./transport";
import { normalizeDateKey } from "../../tasks/lib/taskOccurrenceIdentity";
import type {
  Task,
  TaskAttachment,
  TaskHistoryEntry,
  TaskProjectSummary,
  TaskScheduleDay,
  TaskStatus,
  TaskSubtask,
  TodayTask,
  ScheduleItem,
  ScheduleCalendarDay
} from "../../types/models";

function requireTaskDate(value: string, fieldName: string): string {
  const normalized = normalizeDateKey(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }
  return normalized;
}

export const tasksApi = {
  list: (context?: string, status?: TaskStatus, limit?: number): Promise<Task[]> => {
    const params = new URLSearchParams();
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchTasksFacadeJson<Task[]>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Task> => fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`),
  create: (payload: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> =>
    fetchTasksFacadeJson<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>
  ): Promise<Task> =>
    fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchTasksFacadeJson<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<TaskProjectSummary[]> => fetchTasksFacadeJson<TaskProjectSummary[]>("/api/tasks/projects"),
  pins: (): Promise<{ taskIds: string[] }> => fetchTasksFacadeJson<{ taskIds: string[] }>("/api/tasks/pins"),
  setPin: (id: string, pinned: boolean): Promise<{ taskId: string; pinned: boolean }> =>
    fetchTasksFacadeJson<{ taskId: string; pinned: boolean }>(`/api/tasks/${encodeURIComponent(id)}/pin`, {
      method: "PUT",
      body: JSON.stringify({ pinned })
    }),
  todayList: (date: string): Promise<TodayTask[]> =>
    fetchTasksFacadeJson<TodayTask[]>(`/api/tasks/today?date=${encodeURIComponent(date)}`),
  addToToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate: string,
    opts?: { startTime?: string; endTime?: string; timezone?: string }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      "/api/tasks/today",
      { method: "POST", body: JSON.stringify({ taskId, scheduledDate, occurrenceDate, ...opts }) }
    ),
  removeFromToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate?: string
  ): Promise<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }> => {
    const params = new URLSearchParams({ scheduledDate });
    if (occurrenceDate) params.set("occurrenceDate", occurrenceDate);
    return fetchTasksFacadeJson<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }>(
      `/api/tasks/today/${encodeURIComponent(taskId)}?${params.toString()}`,
      { method: "DELETE" }
    );
  },
  scheduleCalendar: (startDate: string, endDate: string): Promise<ScheduleCalendarDay[]> => {
    const params = new URLSearchParams({ startDate, endDate });
    return fetchTasksFacadeJson<ScheduleCalendarDay[]>(`/api/tasks/schedule-calendar?${params.toString()}`);
  },
  updateScheduleItem: (
    scheduleId: number,
    patch: { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  removeScheduleItem: (scheduleId: number): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "DELETE" }
    ),
  scheduleItemsForTask: (taskId: string): Promise<ScheduleItem[]> =>
    fetchTasksFacadeJson<ScheduleItem[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/schedule-items`
    ),
  completeOccurrence: (id: string, targetDate: string, status: TaskStatus): Promise<{ taskId: string; targetDate: string; status: TaskStatus }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string; status: TaskStatus }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/complete`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate, status })
      }
    );
  },
  moveOccurrence: (id: string, sourceDate: string, targetDate: string): Promise<{ taskId: string; sourceDate: string; targetDate: string }> => {
    const normalizedSourceDate = requireTaskDate(sourceDate, "Occurrence source date");
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; sourceDate: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/move`,
      {
        method: "POST",
        body: JSON.stringify({ sourceDate: normalizedSourceDate, targetDate: normalizedTargetDate })
      }
    );
  },
  skipOccurrenceException: (id: string, targetDate: string): Promise<{ taskId: string; targetDate: string }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/skip-exception`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate })
      }
    );
  },
  schedule: (startDate: string, endDate: string, context?: string, status?: TaskStatus): Promise<TaskScheduleDay[]> => {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    return fetchTasksFacadeJson<TaskScheduleDay[]>(`/api/tasks/schedule?${params.toString()}`);
  },
  history: (id: string): Promise<TaskHistoryEntry[]> =>
    fetchTasksFacadeJson<TaskHistoryEntry[]>(`/api/tasks/${encodeURIComponent(id)}/history`),
  exportCsv: async (): Promise<Blob> => {
    const response = await requestTasksFacade("/api/tasks/export", {
      headers: { Accept: "text/csv" }
    });

    if (!response.ok) {
      throw new Error(`Export failed: ${response.status}`);
    }
    return response.blob();
  },
  importCsv: (file: File): Promise<{ imported: number }> => {
    return file.text().then((text) =>
      fetchTasksFacadeJson<{ imported: number }>("/api/tasks/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text
      })
    );
  }
};

export const taskAttachmentsApi = {
  list: (taskId: string): Promise<TaskAttachment[]> =>
    fetchTasksFacadeJson<TaskAttachment[]>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`),

  upload: async (taskId: string, file: File): Promise<TaskAttachment> => {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments`;
    const clientOpId = crypto.randomUUID();
    const uploadOptions: RequestInit = {
      method: "POST",
      headers: { [CLIENT_OP_ID_HEADER]: clientOpId }
    };
    const uploadToLocal = async (): Promise<TaskAttachment> => {
      const result = await requestLocalDaemonJson<TaskAttachment>(path, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileToBase64(file)
        })
      });
      markSuccessfulLocalRequest(uploadOptions);
      return result;
    };

    if (tasksFacadeEnabled(path, uploadOptions)) {
      return uploadToLocal();
    }

    const formData = new FormData();
    formData.append("file", file);

    let response: Response;
    try {
      response = await fetchWithSessionAuth(`${coreBaseUrl()}${path}`, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: formData
      }, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
    } catch (error) {
      if (autoRoutingCanFallbackToLocal(error, path, uploadOptions)) {
        return uploadToLocal();
      }
      throw error;
    }
    markSuccessfulCoreRequest();

    if (!response.ok) {
      const text = await response.text();
      let message = `Upload failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* ignore */ }
      pushErrorNotification(message, "Upload Error");
      throw new Error(message);
    }

    return response.json() as Promise<TaskAttachment>;
  },

  download: async (taskId: string, attachmentId: string, inline = false): Promise<void> => {
    const suffix = inline ? "" : "?download=1";
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download${suffix}`;
    const response = await requestTasksFacade(path);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);

    if (inline) {
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  },

  fetchBlob: async (taskId: string, attachmentId: string): Promise<{ blob: Blob; filename: string; mimeType: string }> => {
    const response = await requestTasksFacade(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download`
    );
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);
    const mimeType = (response.headers.get("content-type") ?? blob.type ?? "").split(";")[0].trim();
    return { blob, filename, mimeType };
  },

  remove: (taskId: string, attachmentId: string): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    )
};

export const taskSubtasksApi = {
  list: (taskId: string, occurrenceDate: string): Promise<TaskSubtask[]> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`
    );
  },

  create: (taskId: string, occurrenceDate: string, title: string): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`,
      { method: "POST", body: JSON.stringify({ title }) }
    );
  },

  update: (
    taskId: string,
    occurrenceDate: string,
    subtaskId: string,
    updates: { title?: string; isDone?: boolean; sortOrder?: number }
  ): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "PATCH", body: JSON.stringify(updates) }
    );
  },

  remove: (taskId: string, occurrenceDate: string, subtaskId: string): Promise<void> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "DELETE" }
    );
  }
};

