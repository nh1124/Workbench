import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_WORKBENCH_UI_ORIGIN = "http://localhost:5173";
export const ARTIFACT_ITEM_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export interface OpenArtifactInput {
  artifactItemId: string;
}

export interface OpenArtifactResult {
  opened: true;
  url: string;
}

type SpawnOptions = {
  stdio: "ignore";
  windowsHide?: boolean;
};

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateArtifactItemId(artifactItemId: string): void {
  if (!ARTIFACT_ITEM_ID_PATTERN.test(artifactItemId)) {
    throw new Error("Invalid artifactItemId: use 1..200 characters from A-Z, a-z, 0-9, dot, underscore, or hyphen.");
  }
}

export function resolveWorkbenchUiOrigin(rawOrigin = process.env.WORKBENCH_UI_ORIGIN ?? DEFAULT_WORKBENCH_UI_ORIGIN): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error("Invalid WORKBENCH_UI_ORIGIN: expected a valid http or https URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid WORKBENCH_UI_ORIGIN: only http and https URLs are supported.");
  }

  return parsed.origin;
}

export function buildArtifactItemUrl(
  artifactItemId: string,
  rawOrigin = process.env.WORKBENCH_UI_ORIGIN ?? DEFAULT_WORKBENCH_UI_ORIGIN
): string {
  validateArtifactItemId(artifactItemId);
  const url = new URL("/artifacts", resolveWorkbenchUiOrigin(rawOrigin));
  url.searchParams.set("item", artifactItemId);
  return url.toString();
}

function openCommandForPlatform(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openUrlInSystemBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    spawnImpl?: SpawnFn;
  } = {}
): Promise<void> {
  const { command, args } = openCommandForPlatform(options.platform ?? process.platform, url);
  const spawnImpl = options.spawnImpl ?? spawn;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { stdio: "ignore", windowsHide: true });
    } catch (error) {
      settle(new Error(`Failed to launch system browser command: ${errorMessage(error)}`));
      return;
    }

    child.once("error", (error) => {
      settle(new Error(`Failed to launch system browser command: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        settle();
      } else {
        settle(new Error(`System browser command exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

export async function openWorkbenchArtifactItem(
  input: OpenArtifactInput,
  options: {
    uiOrigin?: string;
    platform?: NodeJS.Platform;
    spawnImpl?: SpawnFn;
  } = {}
): Promise<OpenArtifactResult> {
  const url = buildArtifactItemUrl(input.artifactItemId, options.uiOrigin);
  try {
    await openUrlInSystemBrowser(url, {
      platform: options.platform,
      spawnImpl: options.spawnImpl
    });
  } catch (error) {
    throw new Error(`Failed to open artifact URL: ${errorMessage(error)}`);
  }
  return { opened: true, url };
}
