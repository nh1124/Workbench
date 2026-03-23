export type StartPage = "/" | "/projects" | "/tasks" | "/notes" | "/research" | "/artifacts";
export type LocationMode = "preset" | "auto";

export interface UiSettings {
  compactMode: boolean;
  showTimestamps: boolean;
  startPage: StartPage;
  language: string;
  timezone: string;
  location: string;
  locationMode: LocationMode;
  locationPresetId: string;
  locationLatitude: number | null;
  locationLongitude: number | null;
}

export interface LocationPreset {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export const SETTINGS_KEY = "workbench-ui-settings";

export const TIMEZONE_OPTIONS = [
  "Asia/Tokyo",
  "UTC",
  "America/Los_Angeles"
] as const;

const LOCATION_PRESETS_BY_TIMEZONE: Record<string, LocationPreset[]> = {
  "Asia/Tokyo": [
    { id: "jp-tokyo", label: "Tokyo, Tokyo", latitude: 35.6764, longitude: 139.6500 },
    { id: "jp-osaka", label: "Osaka, Osaka", latitude: 34.6937, longitude: 135.5023 },
    { id: "jp-sapporo", label: "Sapporo, Hokkaido", latitude: 43.0618, longitude: 141.3545 },
    { id: "jp-fukuoka", label: "Fukuoka, Fukuoka", latitude: 33.5902, longitude: 130.4017 },
    { id: "jp-naha", label: "Naha, Okinawa", latitude: 26.2124, longitude: 127.6809 }
  ],
  UTC: [
    { id: "uk-london", label: "London, United Kingdom", latitude: 51.5072, longitude: -0.1276 },
    { id: "is-reykjavik", label: "Reykjavik, Iceland", latitude: 64.1466, longitude: -21.9426 },
    { id: "sn-dakar", label: "Dakar, Senegal", latitude: 14.7167, longitude: -17.4677 }
  ],
  "America/Los_Angeles": [
    { id: "us-la", label: "Los Angeles, California", latitude: 34.0522, longitude: -118.2437 },
    { id: "us-san-francisco", label: "San Francisco, California", latitude: 37.7749, longitude: -122.4194 },
    { id: "us-seattle", label: "Seattle, Washington", latitude: 47.6062, longitude: -122.3321 },
    { id: "us-san-diego", label: "San Diego, California", latitude: 32.7157, longitude: -117.1611 }
  ]
};

export function getLocationPresetsForTimezone(timezone: string): LocationPreset[] {
  return LOCATION_PRESETS_BY_TIMEZONE[timezone] ?? LOCATION_PRESETS_BY_TIMEZONE["Asia/Tokyo"];
}

export function getDefaultLocationPreset(timezone: string): LocationPreset {
  return getLocationPresetsForTimezone(timezone)[0];
}

export const defaultSettings: UiSettings = {
  compactMode: false,
  showTimestamps: true,
  startPage: "/",
  language: "English (US)",
  timezone: "Asia/Tokyo",
  location: getDefaultLocationPreset("Asia/Tokyo").label,
  locationMode: "preset",
  locationPresetId: getDefaultLocationPreset("Asia/Tokyo").id,
  locationLatitude: getDefaultLocationPreset("Asia/Tokyo").latitude,
  locationLongitude: getDefaultLocationPreset("Asia/Tokyo").longitude
};

export function normalizeUiSettings(raw: Partial<UiSettings> | null | undefined): UiSettings {
  const timezone = raw?.timezone && TIMEZONE_OPTIONS.includes(raw.timezone as (typeof TIMEZONE_OPTIONS)[number])
    ? raw.timezone
    : defaultSettings.timezone;

  const defaultsByTimezone = getDefaultLocationPreset(timezone);
  const presets = getLocationPresetsForTimezone(timezone);
  const presetExists = presets.some((preset) => preset.id === raw?.locationPresetId);
  const chosenPreset = presetExists
    ? presets.find((preset) => preset.id === raw?.locationPresetId) ?? defaultsByTimezone
    : defaultsByTimezone;

  const locationMode: LocationMode = raw?.locationMode === "auto" ? "auto" : "preset";

  const startPage: StartPage = raw?.startPage && ["/", "/projects", "/tasks", "/notes", "/research", "/artifacts"].includes(raw.startPage)
    ? raw.startPage as StartPage
    : defaultSettings.startPage;

  const normalized: UiSettings = {
    ...defaultSettings,
    ...raw,
    timezone,
    startPage,
    locationMode,
    locationPresetId: locationMode === "preset" ? chosenPreset.id : (raw?.locationPresetId ?? chosenPreset.id),
    location: locationMode === "preset"
      ? chosenPreset.label
      : (raw?.location || "Auto Detect"),
    locationLatitude: locationMode === "preset"
      ? chosenPreset.latitude
      : (typeof raw?.locationLatitude === "number" ? raw.locationLatitude : defaultSettings.locationLatitude),
    locationLongitude: locationMode === "preset"
      ? chosenPreset.longitude
      : (typeof raw?.locationLongitude === "number" ? raw.locationLongitude : defaultSettings.locationLongitude)
  };

  if (raw?.location && locationMode === "preset") {
    normalized.location = chosenPreset.label;
  }

  return normalized;
}

export function loadUiSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return defaultSettings;
    }
    return normalizeUiSettings(JSON.parse(raw) as Partial<UiSettings>);
  } catch {
    return defaultSettings;
  }
}
