import type { IntegrationManifest } from "../types.js";

export const imageGenerationManifest: IntegrationManifest = {
  id: "image_generation",
  displayName: "Image Generation",
  description: "Provider keys and defaults for prompt, reference, and context-based image generation.",
  category: "integration",
  defaultEnabled: true,
  icon: "IMG",
  badge: "Core",
  setupInstructions:
    "Add provider keys for OpenAI or Nano Banana. Without keys, Workbench uses a local mock provider for development previews.",
  fields: [
    {
      key: "openaiApiKey",
      label: "OpenAI API Key",
      type: "password",
      placeholder: "sk-...",
      helperText: "Used when provider=openai or auto selects OpenAI."
    },
    {
      key: "nanobananaApiKey",
      label: "Nano Banana API Key",
      type: "password",
      helperText: "Used when provider=nanobanana or auto selects Nano Banana."
    },
    {
      key: "nanobananaApiUrl",
      label: "Nano Banana API URL",
      type: "text",
      placeholder: "https://api.example.com/images",
      helperText: "Provider endpoint for Nano Banana compatible image generation."
    },
    {
      key: "defaultProvider",
      label: "Default Provider",
      type: "select",
      defaultValue: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Mock", value: "mock" },
        { label: "OpenAI", value: "openai" },
        { label: "Nano Banana", value: "nanobanana" }
      ],
      helperText: "Used when an image request does not specify provider."
    },
    {
      key: "defaultOpenAIModel",
      label: "OpenAI Image Model",
      type: "text",
      defaultValue: "gpt-image-1.5",
      helperText: "Used by the OpenAI adapter for generation and edits."
    },
    {
      key: "defaultNanobananaModel",
      label: "Nano Banana Model",
      type: "text",
      defaultValue: "nanobanana"
    },
    {
      key: "defaultSize",
      label: "Default Size",
      type: "select",
      defaultValue: "1024x1024",
      options: ["1024x1024", "1024x1536", "1536x1024", "auto"]
    },
    {
      key: "defaultQuality",
      label: "Default Quality",
      type: "select",
      defaultValue: "standard",
      options: [
        { label: "Draft", value: "draft" },
        { label: "Standard", value: "standard" },
        { label: "High", value: "high" }
      ]
    },
    {
      key: "defaultSaveToArtifacts",
      label: "Default Save To Artifacts",
      type: "boolean",
      defaultValue: false
    }
  ]
};
