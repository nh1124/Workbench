const PAGE_SIZE = 100;

function usage() {
  console.log(`Usage:
  node infra/scripts/migrate-maintenance-to-proposals.mjs [--dry-run]`);
}

function parseArgs(argv) {
  let dryRun = false;
  for (const argument of argv) {
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--help" || argument === "-h") {
      usage();
      return undefined;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { dryRun };
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function responseSummary(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "empty response";
}

async function requestJson(baseUrl, path, { method = "GET", token, body, label }) {
  const url = new URL(path, `${baseUrl}/`);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error) {
    throw new Error(`Could not connect to Workbench Core at ${url.origin} while attempting to ${label}`, { cause: error });
  }

  const text = await response.text();
  let json;
  try {
    json = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${responseSummary(text)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${responseSummary(text)}`);
  }
  return json;
}

async function resolveToken(baseUrl) {
  const configuredToken = process.env.WORKBENCH_TOKEN?.trim();
  if (configuredToken) return configuredToken;

  const username = process.env.WORKBENCH_USERNAME?.trim();
  const password = process.env.WORKBENCH_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "Set WORKBENCH_TOKEN, or set both WORKBENCH_USERNAME and WORKBENCH_PASSWORD for /accounts/login"
    );
  }
  const result = await requestJson(baseUrl, "/accounts/login", {
    method: "POST",
    body: { username, password },
    label: "log in"
  });
  if (!result || typeof result.accessToken !== "string" || !result.accessToken) {
    throw new Error("Workbench Core login response did not include accessToken");
  }
  console.log(`[AUTH] Logged in as ${username}`);
  return result.accessToken;
}

function scalar(value) {
  if (value === undefined || value === null || value === "") return "(not set)";
  return String(value).replace(/\r?\n/g, " ");
}

function serviceForKind(kind) {
  if (["memory", "brief", "index_drift"].includes(kind)) return "projects";
  if (kind === "note") return "notes";
  if (kind === "artifact") return "artifacts";
  throw new Error(`Unsupported maintenance item kind: ${kind}`);
}

function proposalFor(item) {
  for (const field of ["kind", "resourceId", "title", "excerpt", "projectName"]) {
    if (typeof item?.[field] !== "string") throw new Error(`Maintenance queue item has invalid ${field}`);
  }
  if (!Array.isArray(item.reasons) || !item.reasons.every((value) => typeof value === "string")) {
    throw new Error("Maintenance queue item has invalid reasons");
  }
  if (!Array.isArray(item.suggestedActions) || !item.suggestedActions.every((value) => typeof value === "string")) {
    throw new Error("Maintenance queue item has invalid suggestedActions");
  }

  const suggestedActions = item.suggestedActions.length > 0
    ? item.suggestedActions.map((action) => `  - ${scalar(action)}`).join("\n")
    : "  - (none)";
  const bodyMarkdown = `${item.excerpt.trim()}\n\n---\n\n` +
    `### Legacy maintenance metadata\n\n` +
    `- projectName: ${scalar(item.projectName)}\n` +
    `- path: ${scalar(item.path)}\n` +
    `- authority: ${scalar(item.authority)}\n` +
    `- lifecycleState: ${scalar(item.lifecycleState)}\n` +
    `- lastConfirmedAt: ${scalar(item.lastConfirmedAt)}\n` +
    `- reviewAfter: ${scalar(item.reviewAfter)}\n` +
    `- suggestedActions:\n${suggestedActions}`;

  return {
    kind: `maintenance_${item.kind}`,
    title: `[${item.reasons.join(",")}] ${item.title}`,
    bodyMarkdown,
    evidenceRefs: [{
      service: serviceForKind(item.kind),
      resourceType: item.kind,
      resourceId: item.resourceId,
      pathSnapshot: item.path
    }],
    dedupeKey: `maintenance:${item.kind}:${item.resourceId}`
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const baseUrl = (process.env.WORKBENCH_CORE_URL?.trim() || "http://127.0.0.1:4100").replace(/\/+$/, "");
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`WORKBENCH_CORE_URL is invalid: ${baseUrl}`);
  }
  if (!/^https?:$/.test(parsedBaseUrl.protocol)) {
    throw new Error("WORKBENCH_CORE_URL must use http or https");
  }

  const token = await resolveToken(baseUrl);
  const seenCursors = new Set();
  let cursor;
  let processed = 0;
  let created = 0;
  let deduped = 0;

  console.log(`[INFO] Mode: ${options.dryRun ? "dry-run" : "write"}`);
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const page = await requestJson(baseUrl, `/api/maintenance/queue?${query}`, {
      token,
      label: "read the maintenance queue"
    });
    if (!page || !Array.isArray(page.items)) {
      throw new Error("Maintenance queue response did not include an items array");
    }

    for (const item of page.items) {
      const proposal = proposalFor(item);
      processed += 1;
      if (options.dryRun) {
        console.log(`[WOULD CREATE] ${proposal.title}`);
        continue;
      }
      const result = await requestJson(baseUrl, "/api/analyser/proposals", {
        method: "POST",
        token,
        body: proposal,
        label: `create proposal ${proposal.dedupeKey}`
      });
      if (result?.created === true) {
        created += 1;
        console.log(`[CREATED] ${proposal.title}`);
      } else if (result?.created === false) {
        deduped += 1;
        console.log(`[DEDUPED] ${proposal.title}`);
      } else {
        throw new Error(`Proposal response for ${proposal.dedupeKey} did not include a boolean created field`);
      }
    }

    if (page.nextCursor === undefined || page.nextCursor === null || page.nextCursor === "") break;
    if (typeof page.nextCursor !== "string") {
      throw new Error("Maintenance queue response included an invalid nextCursor");
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Maintenance queue returned a repeated nextCursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  console.log(`\n${options.dryRun ? "[DRY-RUN] Would-create summary" : "[SUMMARY] Migration results"}`);
  console.table(options.dryRun
    ? [{ queueItems: String(processed), wouldCreate: String(processed) }]
    : [{ queueItems: String(processed), created: String(created), deduped: String(deduped) }]);
}

run().catch((error) => {
  console.error(`[ERROR] Maintenance-to-proposals migration failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
