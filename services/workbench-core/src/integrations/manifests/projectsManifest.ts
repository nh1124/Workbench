import type { IntegrationManifest } from "../types.js";

export const projectsManifest: IntegrationManifest = {
  id: "projects",
  displayName: "Projects Service",
  description: "Cross-service project context, linkage, and summaries.",
  category: "integration",
  defaultEnabled: true,
  fields: [
    {
      key: "defaultProjectStatus",
      label: "Default Project Status",
      type: "select",
      options: ["draft", "active", "archived"],
      description: "Default lifecycle state for newly created projects."
    },
    {
      key: "summarySource",
      label: "Summary Source",
      type: "select",
      options: ["rule-based", "llm", "manual"],
      description: "Primary source label for generated project context summaries."
    },
    {
      key: "summaryMaxResources",
      label: "Summary Max Resources",
      type: "number",
      placeholder: "10",
      description: "Maximum linked resources used when generating summaries."
    },
    {
      key: "linkingPolicy",
      label: "Linking Policy",
      type: "text",
      placeholder: "manual",
      description: "Policy hint for how resources are linked to projects."
    }
  ]
};
