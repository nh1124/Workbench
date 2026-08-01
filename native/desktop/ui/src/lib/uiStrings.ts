import { useCallback, useEffect, useState } from "react";
import { loadUiSettings } from "./uiSettings";

export type UiLocale = "en" | "ja";

const en = {
  openCalendarInNewWindow: "Open in a new window",
  addTaskOnThisDay: "Add a task on this day",
  createTaskAtThisDateTime: "New task (this date and time)",
  scheduleExistingTask: "Schedule an existing task",
  searchTasks: "Search tasks",
  noMatchingTasks: "No matching tasks",
} as const;

export type UiStringKey = keyof typeof en;

const ja = {
  openCalendarInNewWindow: "別ウィンドウで開く",
  addTaskOnThisDay: "この日にタスクを追加",
  createTaskAtThisDateTime: "新規タスク（この日時）",
  scheduleExistingTask: "既存タスクを予定",
  searchTasks: "タスクを検索",
  noMatchingTasks: "該当するタスクはありません",
} as const satisfies Record<UiStringKey, string>;

const uiStrings: Record<UiLocale, Record<UiStringKey, string>> = { en, ja };

export function languageToLocale(language: string | null | undefined): UiLocale {
  if (typeof language !== "string") return "en";
  return /japanese/i.test(language) || /[぀-ヿ一-鿿]/.test(language) ? "ja" : "en";
}

function currentLocale(): UiLocale {
  return languageToLocale(loadUiSettings().language);
}

function translate(key: UiStringKey, locale: UiLocale): string {
  return uiStrings[locale][key];
}

export function t(key: UiStringKey): string {
  return translate(key, currentLocale());
}

export function useUiStrings(): typeof t {
  const [locale, setLocale] = useState<UiLocale>(currentLocale);

  useEffect(() => {
    const reloadLocale = () => setLocale(currentLocale());
    window.addEventListener("storage", reloadLocale);
    window.addEventListener("workbench-ui-settings-changed", reloadLocale);
    return () => {
      window.removeEventListener("storage", reloadLocale);
      window.removeEventListener("workbench-ui-settings-changed", reloadLocale);
    };
  }, []);

  return useCallback((key: UiStringKey) => translate(key, locale), [locale]);
}
