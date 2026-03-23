import type { IntegrationManifest } from "../types.js";

export const notesManifest: IntegrationManifest = {
  id: "notes",
  displayName: "Notes Service",
  description: "Knowledge and notes workspace integration.",
  category: "integration",
  defaultEnabled: true,
  fields: [
    {
      key: "defaultProjectId",
      label: "Default Project ID",
      type: "text",
      placeholder: "project-alpha",
      description: "Notes are linked to this project by default."
    },
    {
      key: "maxRecentNotes",
      label: "Recent Notes Limit",
      type: "number",
      placeholder: "20",
      description: "Maximum notes to load for the recent list."
    },
    {
      key: "tagPolicy",
      label: "Tag Policy",
      type: "select",
      options: ["free", "strict"],
      description: "Controls whether note tags are unrestricted or predefined."
    }
  ]
};
