import { useEffect, useState } from "react";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  createdAt: string;
  read: boolean;
}

interface NotificationStore {
  items: AppNotification[];
}

interface PushNotificationInput {
  title: string;
  message: string;
  level?: NotificationLevel;
}

const STORAGE_KEY = "workbench-notifications";
const MAX_ITEMS = 100;
const DEDUPE_WINDOW_MS = 5000;
const MAX_MESSAGE_LENGTH = 220;

const listeners = new Set<() => void>();
let store: NotificationStore = { items: [] };

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeParseStored(raw: string | null): AppNotification[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AppNotification[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item?.id === "string" && typeof item?.message === "string");
  } catch {
    return [];
  }
}

function persist(): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.items));
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function readFromStorage(): void {
  if (!canUseStorage()) return;
  store = { items: safeParseStored(window.localStorage.getItem(STORAGE_KEY)) };
}

function buildId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isDuplicateRecent(title: string, message: string): boolean {
  const latest = store.items[0];
  if (!latest) return false;
  if (latest.title !== title || latest.message !== message) return false;
  const elapsed = Date.now() - new Date(latest.createdAt).getTime();
  return elapsed >= 0 && elapsed < DEDUPE_WINDOW_MS;
}

function inferTitle(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes("connection failed") || lowered.includes("unreachable")) {
    return "Connection Error";
  }
  if (lowered.includes("unauthorized") || lowered.includes("forbidden") || lowered.includes("missing bearer token")) {
    return "Authentication Error";
  }
  return "Service Error";
}

function normalizeMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Backend/proxy HTML error pages are noisy in a small notification area.
  if (/<\/?[a-z][\s\S]*>/i.test(trimmed) || trimmed.toLowerCase().includes("<!doctype html")) {
    const plain = trimmed
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const cannotGet = plain.match(/Cannot GET\s+[^\s]+/i);
    if (cannotGet) return cannotGet[0];
    if (plain) return plain.length > MAX_MESSAGE_LENGTH ? `${plain.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : plain;
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length > MAX_MESSAGE_LENGTH ? `${compact.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : compact;
}

readFromStorage();

export function pushNotification(input: PushNotificationInput): void {
  const title = input.title.trim();
  const message = normalizeMessage(input.message);
  if (!title || !message) return;
  if (isDuplicateRecent(title, message)) return;

  const created: AppNotification = {
    id: buildId(),
    title,
    message,
    level: input.level ?? "info",
    createdAt: new Date().toISOString(),
    read: false
  };

  store = {
    items: [created, ...store.items].slice(0, MAX_ITEMS)
  };
  persist();
  emit();
}

export function pushErrorNotification(message: string, title?: string): void {
  pushNotification({
    title: title?.trim() || inferTitle(message),
    message,
    level: "error"
  });
}

export function markNotificationRead(id: string): void {
  let changed = false;
  store = {
    items: store.items.map((item) => {
      if (item.id !== id || item.read) return item;
      changed = true;
      return { ...item, read: true };
    })
  };
  if (!changed) return;
  persist();
  emit();
}

export function markAllNotificationsRead(): void {
  let changed = false;
  store = {
    items: store.items.map((item) => {
      if (item.read) return item;
      changed = true;
      return { ...item, read: true };
    })
  };
  if (!changed) return;
  persist();
  emit();
}

export function clearNotifications(): void {
  if (store.items.length === 0) return;
  store = { items: [] };
  persist();
  emit();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotifications(): AppNotification[] {
  return store.items;
}

export function getUnreadNotificationCount(): number {
  return store.items.reduce((total, item) => total + (item.read ? 0 : 1), 0);
}

export function useNotifications() {
  const [items, setItems] = useState<AppNotification[]>(() => getNotifications());

  useEffect(() => {
    return subscribeNotifications(() => {
      setItems(getNotifications());
    });
  }, []);

  const unreadCount = items.reduce((total, item) => total + (item.read ? 0 : 1), 0);

  return {
    items,
    unreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications
  };
}
