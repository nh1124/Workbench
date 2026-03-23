import type { IntegrationManifest } from "../types.js";

export const tasksManifest: IntegrationManifest = {
  id: "tasks",
  displayName: "Tasks Service",
  description: "Task execution and schedule orchestration integration.",
  category: "integration",
  defaultEnabled: true,
  fields: [
    {
      key: "lbsBaseUrl",
      label: "LBS Base URL",
      type: "text",
      placeholder: "http://127.0.0.1:8100/api/lbs",
      description: "Primary LBS endpoint used by tasks service.",
      required: true
    },
    {
      key: "timezone",
      label: "Timezone",
      type: "text",
      placeholder: "Asia/Tokyo",
      description: "Timezone for scheduling and completion logic."
    },
    {
      key: "defaultActiveOnly",
      label: "Default Active Filter",
      type: "select",
      options: ["true", "false"],
      description: "Whether the task list defaults to active tasks only."
    }
  ]
};
