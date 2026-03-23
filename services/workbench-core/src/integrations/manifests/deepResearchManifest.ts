import type { IntegrationManifest } from "../types.js";

export const deepResearchManifest: IntegrationManifest = {
  id: "deep_research",
  displayName: "Deep Research",
  description: "Provider keys and defaults for long-running deep research in Workbench Core.",
  category: "integration",
  defaultEnabled: true,
  icon: "🔎",
  badge: "Core",
  setupInstructions:
    "Add at least one provider API key. Workbench Core uses these values for UI and MCP deep research tools.",
  fields: [
    {
      key: "geminiApiKey",
      label: "Gemini API Key",
      type: "password",
      placeholder: "AIza...",
      helperText: "Used for provider=gemini or auto routing when Gemini is selected."
    },
    {
      key: "openaiApiKey",
      label: "OpenAI API Key",
      type: "password",
      placeholder: "sk-...",
      helperText: "Used for provider=openai or auto routing when OpenAI is selected."
    },
    {
      key: "anthropicApiKey",
      label: "Anthropic API Key",
      type: "password",
      placeholder: "sk-ant-...",
      helperText: "Used for provider=anthropic or auto routing when Anthropic is selected."
    },
    {
      key: "defaultProvider",
      label: "Default Provider",
      type: "select",
      defaultValue: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Gemini", value: "gemini" },
        { label: "OpenAI", value: "openai" },
        { label: "Anthropic", value: "anthropic" }
      ],
      helperText: "Used when a research request does not specify provider."
    },
    {
      key: "defaultSpeed",
      label: "Default Speed",
      type: "select",
      defaultValue: "deep",
      options: [
        { label: "Deep", value: "deep" },
        { label: "Fast", value: "fast" }
      ],
      helperText: "Used when speed is not provided at run time."
    },
    {
      key: "defaultTimeoutSec",
      label: "Default Timeout (sec)",
      type: "number",
      defaultValue: 120,
      min: 10,
      max: 3600,
      step: 1,
      helperText: "Sync attempt timeout before optional async continuation."
    },
    {
      key: "defaultAsyncOnTimeout",
      label: "Default Async On Timeout",
      type: "boolean",
      defaultValue: true,
      helperText: "Continue in background and return a job id when sync timeout is reached."
    },
    {
      key: "defaultSaveToArtifacts",
      label: "Default Save To Artifacts",
      type: "boolean",
      defaultValue: true,
      helperText: "Auto-save completed research output into Artifacts unless overridden."
    }
  ]
};
