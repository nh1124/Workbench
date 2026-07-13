import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertProvisioning } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

type ServiceId = "notes" | "artifacts" | "projects" | "images" | "mindmaps" | "wbs" | "insights";

type ServiceTarget = {
  id: ServiceId;
  baseUrl: string;
  apiKey: string;
};

type AuthenticatedProvisioningContext = {
  userId: string;
  username: string;
};

const serviceTargets: ServiceTarget[] = [
  {
    id: "notes",
    baseUrl: requireEnv("NOTES_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_NOTES")
  },
  {
    id: "artifacts",
    baseUrl: requireEnv("ARTIFACTS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_ARTIFACTS")
  },
  {
    id: "images",
    baseUrl: requireEnv("IMAGES_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_IMAGES")
  },
  {
    id: "mindmaps",
    baseUrl: requireEnv("MINDMAPS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_MINDMAPS")
  },
  {
    id: "wbs",
    baseUrl: requireEnv("WBS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_WBS")
  }
];

const projectsServiceUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsInternalApiKey = optionalEnv("INTERNAL_API_KEY_PROJECTS");
if (projectsServiceUrl && projectsInternalApiKey) {
  serviceTargets.push({
    id: "projects",
    baseUrl: projectsServiceUrl,
    apiKey: projectsInternalApiKey
  });
}

const insightsServiceUrl = optionalEnv("INSIGHTS_SERVICE_URL");
const insightsInternalApiKey = optionalEnv("INTERNAL_API_KEY_INSIGHTS");
if (insightsServiceUrl && insightsInternalApiKey) {
  serviceTargets.push({
    id: "insights",
    baseUrl: insightsServiceUrl,
    apiKey: insightsInternalApiKey
  });
}

export function configuredServiceIds(): ServiceId[] {
  return serviceTargets.map((service) => service.id);
}

export async function provisionAccountToServices(userId: string, username: string) {
  const results = await Promise.all(
    serviceTargets.map(async (service) => {
      try {
        const response = await fetch(`${service.baseUrl}/internal/accounts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": service.apiKey
          },
          body: JSON.stringify({ coreUserId: userId, username })
        });

        if (!response.ok) {
          const text = await response.text();
          await upsertProvisioning(userId, service.id, "error", text || `HTTP ${response.status}`);
          return { serviceId: service.id, status: "error" as const, message: text || `HTTP ${response.status}` };
        }

        await upsertProvisioning(userId, service.id, "ok");
        return { serviceId: service.id, status: "ok" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provisioning failed";
        await upsertProvisioning(userId, service.id, "error", message);
        return { serviceId: service.id, status: "error" as const, message };
      }
    })
  );

  return results;
}

async function ensureServiceAccountProvisioned(
  authContext: AuthenticatedProvisioningContext,
  serviceId: ServiceId
): Promise<void> {
  const service = serviceTargets.find((target) => target.id === serviceId);
  if (!service) return;

  try {
    const response = await fetch(`${service.baseUrl}/internal/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": service.apiKey
      },
      body: JSON.stringify({ coreUserId: authContext.userId, username: authContext.username })
    });

    if (!response.ok) {
      const text = await response.text();
      const message = text || `HTTP ${response.status}`;
      await upsertProvisioning(authContext.userId, service.id, "error", message);
      throw new Error(`${service.id} service provisioning failed: ${message}`);
    }

    await upsertProvisioning(authContext.userId, service.id, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : `${service.id} service provisioning failed`;
    await upsertProvisioning(authContext.userId, service.id, "error", message);
    throw error;
  }
}

export async function ensureImagesAccountProvisioned(authContext: AuthenticatedProvisioningContext): Promise<void> {
  await ensureServiceAccountProvisioned(authContext, "images");
}

export async function ensureMindmapsAccountProvisioned(authContext: AuthenticatedProvisioningContext): Promise<void> {
  await ensureServiceAccountProvisioned(authContext, "mindmaps");
}

export async function ensureWbsAccountProvisioned(authContext: AuthenticatedProvisioningContext): Promise<void> {
  await ensureServiceAccountProvisioned(authContext, "wbs");
}

export async function ensureInsightsAccountProvisioned(authContext: AuthenticatedProvisioningContext): Promise<void> {
  await ensureServiceAccountProvisioned(authContext, "insights");
}
