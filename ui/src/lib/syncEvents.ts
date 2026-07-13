import {
  getWorkbenchAutoLocalFallbackActive,
  getWorkbenchLocalRoutingMode,
  resolveWorkbenchLocalRoutingTarget,
  WORKBENCH_LOCAL_MODE_CHANGED_EVENT
} from "../config/services";
import { coreApiPath, initializeSessionStorage, sessionAuthHeaders } from "./api";

export type SyncEvent = {
  domain: string;
  resourceId: string;
  action: "create" | "update" | "delete" | "upsert";
  ts: string;
};

type SyncEventCallback = (event: SyncEvent) => void;
type Subscription = {
  domains: Set<string>;
  callback: SyncEventCallback;
};

function isSyncEvent(value: unknown): value is SyncEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SyncEvent>;
  return typeof event.domain === "string"
    && typeof event.resourceId === "string"
    && (event.action === "create" || event.action === "update" || event.action === "delete" || event.action === "upsert")
    && typeof event.ts === "string";
}

export function createSyncEventStreamParser(onEvent: SyncEventCallback): { push: (chunk: string) => void } {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (eventName === "sync" && dataLines.length > 0) {
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as unknown;
        if (isSyncEvent(parsed)) onEvent(parsed);
      } catch {
        // Ignore malformed frames and continue parsing the stream.
      }
    }
    eventName = "";
    dataLines = [];
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          dispatch();
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator >= 0 ? line.slice(0, separator) : line;
          let value = separator >= 0 ? line.slice(separator + 1) : "";
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") eventName = value;
          if (field === "data") dataLines.push(value);
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }
  };
}

export function createDebouncedCallback(
  callback: () => void,
  delayMs: number
): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        callback();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

const subscriptions = new Set<Subscription>();
let activeController: AbortController | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 1_000;
let routingListenersAttached = false;

function routingTargetIsCore(): boolean {
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (resolveWorkbenchLocalRoutingTarget(getWorkbenchLocalRoutingMode(), online) !== "core") return false;
  return !(getWorkbenchLocalRoutingMode() === "auto" && getWorkbenchAutoLocalFallbackActive());
}

function dispatchSyncEvent(event: SyncEvent): void {
  for (const subscription of subscriptions) {
    if (subscription.domains.has(event.domain)) subscription.callback(event);
  }
}

function stopConnection(): void {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  activeController?.abort();
  activeController = undefined;
}

function scheduleReconnect(): void {
  if (subscriptions.size === 0 || !routingTargetIsCore() || reconnectTimer !== undefined) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (activeController || subscriptions.size === 0 || !routingTargetIsCore()) return;
  await initializeSessionStorage();
  if (activeController || subscriptions.size === 0 || !routingTargetIsCore()) return;

  const controller = new AbortController();
  activeController = controller;
  const connectedAt = Date.now();
  try {
    const response = await fetch(coreApiPath("/api/sync/events"), {
      headers: sessionAuthHeaders(),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Sync event stream failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("Sync event stream response has no body");

    const parser = createSyncEventStreamParser(dispatchSyncEvent);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("[sync-events] connection closed", error);
    }
  } finally {
    if (activeController === controller) activeController = undefined;
    if (!controller.signal.aborted) {
      if (Date.now() - connectedAt >= 30_000) reconnectDelayMs = 1_000;
      scheduleReconnect();
    }
  }
}

function reevaluateConnection(): void {
  if (subscriptions.size === 0 || !routingTargetIsCore()) {
    stopConnection();
    return;
  }
  if (!activeController && reconnectTimer === undefined) void connect();
}

function attachRoutingListeners(): void {
  if (routingListenersAttached || typeof window === "undefined") return;
  routingListenersAttached = true;
  window.addEventListener(WORKBENCH_LOCAL_MODE_CHANGED_EVENT, reevaluateConnection);
  window.addEventListener("online", reevaluateConnection);
  window.addEventListener("offline", reevaluateConnection);
}

function detachRoutingListeners(): void {
  if (!routingListenersAttached || typeof window === "undefined") return;
  routingListenersAttached = false;
  window.removeEventListener(WORKBENCH_LOCAL_MODE_CHANGED_EVENT, reevaluateConnection);
  window.removeEventListener("online", reevaluateConnection);
  window.removeEventListener("offline", reevaluateConnection);
}

export function subscribeSyncEvents(
  domains: Iterable<string>,
  callback: SyncEventCallback
): () => void {
  const subscription = { domains: new Set(domains), callback };
  subscriptions.add(subscription);
  attachRoutingListeners();
  reevaluateConnection();

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) {
      stopConnection();
      detachRoutingListeners();
      reconnectDelayMs = 1_000;
    }
  };
}
