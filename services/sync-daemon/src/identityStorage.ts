import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ClientIdentity = {
  localClientId: string;
  localClientToken: string;
  deviceId: string;
  syncRootId: string;
};

export type SecureIdentityMode = "off" | "auto" | "required";
export type IdentitySource = "env" | "secure" | "file";

export type IdentityStorageConfig = {
  syncRoot: string;
  deviceId: string;
  syncRootId: string;
  persistClientIdentity?: boolean;
  secureClientIdentity?: SecureIdentityMode;
};

export type SecureIdentityBackend = {
  name: string;
  read(config: IdentityStorageConfig): Promise<ClientIdentity | undefined>;
  write(config: IdentityStorageConfig, identity: ClientIdentity): Promise<void>;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

let secureIdentityBackendForTest: SecureIdentityBackend | null | undefined;

export function setSecureIdentityBackendForTest(backend: SecureIdentityBackend | null | undefined): void {
  secureIdentityBackendForTest = backend;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function parseSecureIdentityMode(value: string | undefined): SecureIdentityMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return "off";
  }
  if (normalized === "auto") {
    return "auto";
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "required") {
    return "required";
  }
  return "off";
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function parseIdentityJson(raw: string, config: IdentityStorageConfig): ClientIdentity {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    localClientId: requiredString(parsed.localClientId, "localClientId"),
    localClientToken: requiredString(parsed.localClientToken, "localClientToken"),
    deviceId: typeof parsed.deviceId === "string" && parsed.deviceId.trim() ? parsed.deviceId.trim() : config.deviceId,
    syncRootId: typeof parsed.syncRootId === "string" && parsed.syncRootId.trim() ? parsed.syncRootId.trim() : config.syncRootId
  };
}

function serializeIdentity(identity: ClientIdentity): string {
  return JSON.stringify(identity, null, 2);
}

export function identityPath(config: IdentityStorageConfig): string {
  return join(config.syncRoot, ".workbench", "client-identity.json");
}

function windowsProtectedIdentityPath(config: IdentityStorageConfig): string {
  return join(config.syncRoot, ".workbench", "client-identity.dpapi");
}

function secureIdentityKey(config: IdentityStorageConfig): string {
  const rootHash = createHash("sha256").update(resolve(config.syncRoot)).digest("hex").slice(0, 16);
  return `Workbench.LocalDaemonClient.${config.syncRootId}.${rootHash}`;
}

async function runCommand(command: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 10000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

function powerShellCommand(): string {
  return env("WORKBENCH_POWERSHELL_COMMAND") ?? "powershell.exe";
}

async function protectWithWindowsDpapi(raw: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try { Add-Type -AssemblyName System.Security } catch {}",
    "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData } catch {}",
    "$raw = [Console]::In.ReadToEnd()",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)",
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))"
  ].join("; ");
  const result = await runCommand(powerShellCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], raw);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Windows DPAPI protect failed");
  }
  return result.stdout.trim();
}

async function unprotectWithWindowsDpapi(protectedData: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try { Add-Type -AssemblyName System.Security } catch {}",
    "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData } catch {}",
    "$raw = [Console]::In.ReadToEnd().Trim()",
    "$protected = [Convert]::FromBase64String($raw)",
    "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))"
  ].join("; ");
  const result = await runCommand(powerShellCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], protectedData);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Windows DPAPI unprotect failed");
  }
  return result.stdout;
}

const windowsDpapiBackend: SecureIdentityBackend = {
  name: "windows-dpapi",
  async read(config) {
    const pathValue = windowsProtectedIdentityPath(config);
    try {
      const encrypted = await fs.readFile(pathValue, "utf8");
      return parseIdentityJson(await unprotectWithWindowsDpapi(encrypted), config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async write(config, identity) {
    const pathValue = windowsProtectedIdentityPath(config);
    await fs.mkdir(dirname(pathValue), { recursive: true });
    await fs.writeFile(pathValue, `${await protectWithWindowsDpapi(serializeIdentity(identity))}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.chmod(pathValue, 0o600).catch(() => undefined);
  }
};

const macosKeychainBackend: SecureIdentityBackend = {
  name: "macos-keychain",
  async read(config) {
    const key = secureIdentityKey(config);
    const result = await runCommand("security", ["find-generic-password", "-s", key, "-a", "Workbench", "-w"]);
    if (result.code !== 0) {
      if (result.code === 44 || /could not be found|not found/i.test(result.stderr)) {
        return undefined;
      }
      throw new Error(result.stderr.trim() || "macOS Keychain read failed");
    }
    return parseIdentityJson(result.stdout, config);
  },
  async write(config, identity) {
    const key = secureIdentityKey(config);
    const result = await runCommand("security", [
      "add-generic-password",
      "-s",
      key,
      "-a",
      "Workbench",
      "-w",
      serializeIdentity(identity),
      "-U"
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "macOS Keychain write failed");
    }
  }
};

const linuxSecretToolBackend: SecureIdentityBackend = {
  name: "linux-secret-tool",
  async read(config) {
    const result = await runCommand("secret-tool", [
      "lookup",
      "application",
      "workbench",
      "kind",
      "local-daemon-client",
      "sync-root-key",
      secureIdentityKey(config)
    ]);
    if (result.code !== 0) {
      if (result.code === 1 && result.stdout.trim().length === 0) {
        return undefined;
      }
      throw new Error(result.stderr.trim() || "secret-tool lookup failed");
    }
    return result.stdout.trim() ? parseIdentityJson(result.stdout, config) : undefined;
  },
  async write(config, identity) {
    const result = await runCommand("secret-tool", [
      "store",
      "--label",
      "Workbench Local Daemon Client",
      "application",
      "workbench",
      "kind",
      "local-daemon-client",
      "sync-root-key",
      secureIdentityKey(config)
    ], serializeIdentity(identity));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "secret-tool store failed");
    }
  }
};

function secureIdentityBackend(): SecureIdentityBackend | undefined {
  if (secureIdentityBackendForTest !== undefined) {
    return secureIdentityBackendForTest ?? undefined;
  }
  const currentPlatform = osPlatform();
  if (currentPlatform === "win32") {
    return windowsDpapiBackend;
  }
  if (currentPlatform === "darwin") {
    return macosKeychainBackend;
  }
  if (currentPlatform === "linux") {
    return linuxSecretToolBackend;
  }
  return undefined;
}

async function readIdentityFile(config: IdentityStorageConfig): Promise<ClientIdentity | undefined> {
  try {
    return parseIdentityJson(await fs.readFile(identityPath(config), "utf8"), config);
  } catch {
    return undefined;
  }
}

async function removeIdentityFile(config: IdentityStorageConfig): Promise<void> {
  await fs.rm(identityPath(config), { force: true }).catch(() => undefined);
}

async function writeIdentityFile(config: IdentityStorageConfig, identity: ClientIdentity): Promise<void> {
  const pathValue = identityPath(config);
  await fs.mkdir(dirname(pathValue), { recursive: true });
  await fs.writeFile(pathValue, `${serializeIdentity(identity)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(pathValue, 0o600).catch(() => undefined);
}

async function readSecureIdentity(config: IdentityStorageConfig): Promise<ClientIdentity | undefined> {
  const mode = config.secureClientIdentity ?? "off";
  if (mode === "off") {
    return undefined;
  }

  const backend = secureIdentityBackend();
  if (!backend) {
    if (mode === "required") {
      throw new Error("Secure local client identity storage is not available on this platform.");
    }
    return undefined;
  }

  try {
    return await backend.read(config);
  } catch (error) {
    if (mode === "required") {
      throw error;
    }
    return undefined;
  }
}

async function writeSecureIdentity(config: IdentityStorageConfig, identity: ClientIdentity): Promise<boolean> {
  const mode = config.secureClientIdentity ?? "off";
  if (mode === "off") {
    return false;
  }

  const backend = secureIdentityBackend();
  if (!backend) {
    if (mode === "required") {
      throw new Error("Secure local client identity storage is not available on this platform.");
    }
    return false;
  }

  try {
    await backend.write(config, identity);
    await removeIdentityFile(config);
    return true;
  } catch (error) {
    if (mode === "required") {
      throw error;
    }
    return false;
  }
}

export async function readIdentityWithSource(
  config: IdentityStorageConfig
): Promise<{ identity: ClientIdentity; source: IdentitySource } | undefined> {
  const envClientId = env("WORKBENCH_LOCAL_CLIENT_ID");
  const envClientToken = env("WORKBENCH_LOCAL_CLIENT_TOKEN");
  if (envClientId && envClientToken) {
    return {
      identity: {
        localClientId: envClientId,
        localClientToken: envClientToken,
        deviceId: config.deviceId,
        syncRootId: config.syncRootId
      },
      source: "env"
    };
  }

  const secureIdentity = await readSecureIdentity(config);
  if (secureIdentity) {
    return { identity: secureIdentity, source: "secure" };
  }

  if (config.persistClientIdentity === false) {
    return undefined;
  }

  const fileIdentity = await readIdentityFile(config);
  if (!fileIdentity) {
    return undefined;
  }

  await writeSecureIdentity(config, fileIdentity);
  return { identity: fileIdentity, source: "file" };
}

export async function readIdentity(config: IdentityStorageConfig): Promise<ClientIdentity | undefined> {
  return (await readIdentityWithSource(config))?.identity;
}

export async function writeIdentity(config: IdentityStorageConfig, identity: ClientIdentity): Promise<IdentitySource | "memory"> {
  if (await writeSecureIdentity(config, identity)) {
    return "secure";
  }
  if (config.persistClientIdentity !== false) {
    await writeIdentityFile(config, identity);
    return "file";
  }
  return "memory";
}
