export const integrationManifestIds = [
  "notes",
  "artifacts",
  "tasks",
  "projects",
  "deep_research"
] as const;

export type IntegrationManifestId = (typeof integrationManifestIds)[number];

export interface IntegrationSelectOption {
  label: string;
  value: string;
}

export interface IntegrationManifestField {
  key: string;
  label: string;
  type: "text" | "number" | "password" | "select" | "textarea" | "boolean";
  placeholder?: string;
  description?: string;
  required?: boolean;
  helperText?: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<string | IntegrationSelectOption>;
}

export interface IntegrationManifest {
  id: IntegrationManifestId;
  displayName: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  icon?: string;
  badge?: string;
  setupInstructions?: string;
  fields: IntegrationManifestField[];
}
