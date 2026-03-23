import type { IntegrationManifest } from "../types.js";

export const artifactsManifest: IntegrationManifest = {
  id: "artifacts",
  displayName: "Artifacts Service",
  description: "Files, links, and deliverables integration.",
  category: "integration",
  defaultEnabled: true,
  fields: [
    {
      key: "defaultArtifactType",
      label: "Default Artifact Type",
      type: "select",
      options: ["document", "design", "code", "other"],
      description: "Default type used for new artifacts."
    },
    {
      key: "storageNamespace",
      label: "Storage Namespace",
      type: "text",
      placeholder: "workbench-main",
      description: "Logical namespace for artifact storage."
    },
    {
      key: "maxListItems",
      label: "List Page Size",
      type: "number",
      placeholder: "50",
      description: "Maximum artifacts returned per list operation."
    }
  ]
};
