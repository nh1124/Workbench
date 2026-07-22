import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyserClient, artifactsClient, serviceBaseUrls } from "../internalClients.js";
import { runSkillIntegrityCheck } from "../analyserSkillIntegrity.js";
import { ensureAnalyserAccountProvisioned } from "../serviceProvisioning.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
  dependencies?: {
    analyserClient?: Partial<typeof analyserClient>;
    artifactsClient?: Pick<typeof artifactsClient, "treeList">;
    ensureAnalyserAccountProvisioned?: typeof ensureAnalyserAccountProvisioned;
    requireAnalyserConfigured?: () => void;
    runWithAuthContext?: typeof runWithAuthContext;
  };
};

const OBSERVATION_SOURCES = [
  "workbench_change",
  "mcp_access",
  "ui_access",
  "agent_session",
  "pc_activity",
  "local_file"
] as const;

const OPERATION_KINDS = [
  "artifact_move",
  "artifact_metadata_update",
  "artifact_secondary_membership_add",
  "progress_note_upsert"
] as const;

const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
} as const;

const idempotentWriteAnnotations = {
  ...writeAnnotations,
  idempotentHint: true
} as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date");
const isoDateTimeSchema = z.string().datetime({ offset: true });
const limitSchema = z.number().int().min(1).max(200).optional();
const cursorSchema = boundedText(4_000).optional();
const holderSchema = boundedText(2_000);
const leaseSecondsSchema = z.number().int().min(1).max(86_400).optional();

const resourceRefSchema = z.object({
  service: z.string().trim().min(1),
  resourceType: z.string().trim().min(1),
  resourceId: z.string().trim().min(1),
  pathSnapshot: z.string().optional()
}).strict();

const evidenceRefsSchema = z.array(resourceRefSchema).max(50).optional();
const scalarSchema = z.union([
  z.string().trim().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null()
]);
const proposedActionSchema = z.object({
  kind: z.union([z.enum(OPERATION_KINDS), z.literal("other")]),
  params: z.record(z.union([
    scalarSchema,
    z.array(z.string().trim().max(2_000)).max(50)
  ])).optional()
}).strict();
const confidenceEvidenceSchema = z.object({
  deterministicTarget: z.boolean().optional(),
  currentEvidence: z.boolean().optional(),
  policyAllowed: z.boolean().optional(),
  concurrencyProtected: z.boolean().optional(),
  reversibleOrNonDestructive: z.boolean().optional(),
  notes: z.string().trim().max(2_000).optional()
}).strict();

// NOTE: keep these MCP tool input schemas as plain ZodObjects (no trailing
// .refine/.superRefine/discriminatedUnion). The MCP SDK derives the advertised
// JSON Schema from a schema's `.shape`; a ZodEffects/ZodUnion has no `.shape`,
// so the SDK publishes empty `properties: {}` and clients then stringify every
// structured argument (arrays/objects/numbers), which the server rejects. The
// cross-field rules below are still enforced downstream by the analyser service,
// which re-validates every payload with its own refined schemas.
const observationListSchema = z.object({
  source: z.enum(OBSERVATION_SOURCES).optional(),
  machineId: z.string().uuid().optional(),
  projectId: boundedText(2_000).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
}).strict();

const derivedCaptureInputSchema = z.object({
  machineId: z.string().uuid().optional(),
  kind: boundedText(100),
  title: boundedText(500),
  summaryMarkdown: z.string().max(20_000),
  evidenceRefs: evidenceRefsSchema,
  occurredAt: isoDateTimeSchema,
  dedupeKey: boundedText(500)
}).strict();

const derivedCaptureListSchema = z.object({
  kind: boundedText(100).optional(),
  machineId: z.string().uuid().optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
}).strict().superRefine((value, context) => {
  if (value.from && value.to && new Date(value.from).getTime() > new Date(value.to).getTime()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
  }
});

const skillSnapshotInputSchema = z.object({
  skillKey: boundedText(200),
  skillVersion: z.string().max(100).optional(),
  bodyMarkdown: z.string().max(200_000),
  sourceRef: z.string().max(500).optional()
}).strict();

const skillSnapshotListSchema = z.object({
  limit: limitSchema
}).strict();

const summaryListSchema = z.object({
  kind: boundedText(100).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  routineKey: boundedText(2_000).optional(),
  limit: limitSchema,
  cursor: cursorSchema
}).strict();

const summaryInputSchema = z.object({
  kind: boundedText(100),
  periodStart: dateSchema,
  periodEnd: dateSchema,
  title: boundedText(500),
  bodyMarkdown: z.string().trim().max(200_000),
  metrics: z.record(z.unknown()).optional(),
  evidenceRefs: evidenceRefsSchema,
  routineKey: boundedText(2_000).optional(),
  runId: boundedText(2_000).optional(),
  expectedVersion: z.number().int().positive().optional()
}).strict();

const proposalListSchema = z.object({
  status: z.enum(["open", "approved", "rejected", "executed", "superseded"]).optional(),
  kind: boundedText(100).optional(),
  routineKey: boundedText(2_000).optional(),
  limit: limitSchema,
  cursor: cursorSchema
}).strict();

const proposalInputSchema = z.object({
  kind: boundedText(100),
  title: boundedText(500),
  bodyMarkdown: z.string().trim().max(200_000),
  evidenceRefs: evidenceRefsSchema,
  proposedAction: proposedActionSchema.optional(),
  confidenceEvidence: confidenceEvidenceSchema.optional(),
  routineKey: boundedText(2_000).optional(),
  runId: boundedText(2_000).optional(),
  dedupeKey: boundedText(2_000).optional()
}).strict();

// Flattened to a single ZodObject (not a discriminatedUnion) so the MCP SDK can
// publish a non-empty JSON Schema; the analyser service enforces the per-action
// requirements (mark_executed needs operationId; update_content needs >=1 field).
const proposalUpdateSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["update_content", "mark_executed"]),
  title: boundedText(500).optional(),
  bodyMarkdown: z.string().trim().max(200_000).optional(),
  evidenceRefs: evidenceRefsSchema,
  proposedAction: proposedActionSchema.optional(),
  confidenceEvidence: confidenceEvidenceSchema.optional(),
  operationId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive()
}).strict();

const operationInputSchema = z.object({
  operationKind: z.enum(OPERATION_KINDS),
  approvalBasis: z.enum(["policy", "proposal"]),
  proposalId: boundedText(2_000).optional(),
  beforeRefs: evidenceRefsSchema,
  afterRefs: evidenceRefsSchema,
  result: z.enum(["succeeded", "failed", "skipped"]),
  detail: z.record(scalarSchema).optional(),
  runId: boundedText(2_000).optional(),
  agentLabel: boundedText(2_000).optional(),
  idempotencyKey: boundedText(2_000)
}).strict();

const publicationInputSchema = z.object({
  sourceKind: z.enum(["summary", "proposal"]),
  sourceId: boundedText(2_000),
  targetKind: z.enum(["note", "artifact"]),
  targetId: boundedText(2_000),
  targetRef: resourceRefSchema.optional(),
  contentHash: z.string().trim().min(8).max(128).regex(/^[0-9a-fA-F]+$/, "Expected a hexadecimal content hash")
}).strict();

function requireAnalyserConfigured(): void {
  if (!serviceBaseUrls.analyser) throw new Error("Analyser service is not configured");
}

async function runWithAnalyserAccount<T>(ctx: ToolContext, operation: () => Promise<T>): Promise<T> {
  const requireConfigured = ctx.dependencies?.requireAnalyserConfigured ?? requireAnalyserConfigured;
  const withAuthContext = ctx.dependencies?.runWithAuthContext ?? runWithAuthContext;
  const ensureAccountProvisioned = ctx.dependencies?.ensureAnalyserAccountProvisioned
    ?? ensureAnalyserAccountProvisioned;
  requireConfigured();
  return withAuthContext(ctx.accessToken, async (authContext) => {
    await ensureAccountProvisioned(authContext);
    return operation();
  });
}

export function registerAnalyserTools(server: McpServer, ctx: ToolContext): void {
  const client = { ...analyserClient, ...ctx.dependencies?.analyserClient };
  const artifactClient = { ...artifactsClient, ...ctx.dependencies?.artifactsClient };

  server.registerTool(
    "analyser.status.get",
    {
      title: "Get Analyser Status",
      description: "Get an overview of analyser routines, machines, and open proposals.",
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations
    },
    async () => asMcpText(await runWithAnalyserAccount(ctx, () => client.getStatus(ctx.accessToken)))
  );

  server.registerTool(
    "analyser.settings.get",
    {
      title: "Get Effective Analyser Settings",
      description: "Get the read-only effective collection policy; agents cannot modify collection settings.",
      inputSchema: z.object({ machineId: z.string().uuid().optional() }).strict(),
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.getEffectiveSettings(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.observations.list",
    {
      title: "List Analyser Observations",
      description: "List collected observations using source, machine, project, time, and pagination filters.",
      inputSchema: observationListSchema,
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.listObservations(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.observations.pull",
    {
      title: "Pull Pending Analyser Observations",
      description: "Pull pending observations for a claimed run and advance that run's pending cursor.",
      inputSchema: z.object({
        runId: z.string().uuid(),
        holder: holderSchema,
        limit: z.number().int().min(1).max(500).optional()
      }).strict(),
      annotations: writeAnnotations
    },
    async ({ runId, ...payload }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.pullRun(ctx.accessToken, runId, payload)
    ))
  );

  server.registerTool(
    "analyser.captures.derived.ingest",
    {
      title: "Ingest Analyser Derived Capture",
      description: "Ingest TEXT that a local agent derived from screenshots/captures on the capture machine; the screenshot image is never uploaded. Requires the owner to have enabled screenshotDerivedUpload in Analyser Settings; otherwise the call is rejected.",
      inputSchema: derivedCaptureInputSchema,
      annotations: idempotentWriteAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.ingestDerivedCapture(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.captures.derived.list",
    {
      title: "List Analyser Derived Captures",
      description: "List text derived from local captures using kind, machine, time, and pagination filters.",
      inputSchema: derivedCaptureListSchema,
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.listDerivedCaptures(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.skills.snapshot.upsert",
    {
      title: "Upsert Analyser Skill Snapshot",
      description: "Store Analyser's own copy (snapshot) of a canonical AgentSkills skill body so drift/removal can be detected; call explicitly after reading the canonical skill. Bodies only, no secrets.",
      inputSchema: skillSnapshotInputSchema,
      annotations: idempotentWriteAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.upsertSkillSnapshot(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.skills.snapshot.list",
    {
      title: "List Analyser Skill Snapshots",
      description: "List stored Analyser skill snapshots without returning their bodies.",
      inputSchema: skillSnapshotListSchema,
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.listSkillSnapshots(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.skills.integrity.run",
    {
      title: "Run Skill Integrity Check",
      description: "Compare canonical AgentSkills bodies against Analyser skill snapshots: block routines whose skill was removed (fail-safe) and open a proposal for drifted skills.",
      inputSchema: z.object({}).strict(),
      annotations: writeAnnotations
    },
    async () => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => runSkillIntegrityCheck(ctx.accessToken, {
        treeList: artifactClient.treeList,
        listRoutines: client.listRoutines,
        listSkillSnapshots: client.listSkillSnapshots,
        setRoutineSkillFlags: client.setRoutineSkillFlags,
        createProposal: client.createProposal
      })
    ))
  );

  server.registerTool(
    "analyser.routines.list",
    {
      title: "List Analyser Routines",
      description: "List analyser routines and their current scheduling configuration.",
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations
    },
    async () => asMcpText(await runWithAnalyserAccount(ctx, () => client.listRoutines(ctx.accessToken)))
  );

  server.registerTool(
    "analyser.routines.claim",
    {
      title: "Claim Due Analyser Routine",
      description: "Claim one due routine atomically; returns {claim: null} when none are due.",
      inputSchema: z.object({
        key: boundedText(100).optional(),
        holder: holderSchema,
        leaseSeconds: leaseSecondsSchema
      }).strict(),
      annotations: writeAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.claimRoutine(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.routines.heartbeat",
    {
      title: "Heartbeat Analyser Run",
      description: "Renew the lease for a claimed analyser run held by this agent.",
      inputSchema: z.object({
        runId: z.string().uuid(),
        holder: holderSchema,
        leaseSeconds: leaseSecondsSchema
      }).strict(),
      annotations: idempotentWriteAnnotations
    },
    async ({ runId, ...payload }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.heartbeatRun(ctx.accessToken, runId, payload)
    ))
  );

  server.registerTool(
    "analyser.routines.complete",
    {
      title: "Complete Analyser Run",
      description: "Complete a run, atomically commit its cursor, and schedule the next run.",
      inputSchema: z.object({ runId: z.string().uuid(), holder: holderSchema }).strict(),
      annotations: writeAnnotations
    },
    async ({ runId, ...payload }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.completeRun(ctx.accessToken, runId, payload)
    ))
  );

  server.registerTool(
    "analyser.routines.fail",
    {
      title: "Fail Analyser Run",
      description: "Fail a run without advancing its cursor so the observations can be retried.",
      inputSchema: z.object({
        runId: z.string().uuid(),
        holder: holderSchema,
        errorSummary: boundedText(2_000)
      }).strict(),
      annotations: writeAnnotations
    },
    async ({ runId, ...payload }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.failRun(ctx.accessToken, runId, payload)
    ))
  );

  server.registerTool(
    "analyser.summaries.list",
    {
      title: "List Analyser Summaries",
      description: "List analyser summaries by kind, period, routine, and pagination filters.",
      inputSchema: summaryListSchema,
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.listSummaries(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.summaries.get",
    {
      title: "Get Analyser Summary",
      description: "Get one analyser summary including its Markdown body, metrics, and evidence references.",
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      annotations: readAnnotations
    },
    async ({ id }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.getSummary(ctx.accessToken, id)
    ))
  );

  server.registerTool(
    "analyser.summaries.upsert",
    {
      title: "Upsert Analyser Summary",
      description: "Create or version-update an analyser summary with metrics and evidence references.",
      inputSchema: summaryInputSchema,
      annotations: idempotentWriteAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.upsertSummary(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.proposals.list",
    {
      title: "List Analyser Proposals",
      description: "List analyser proposals by status, kind, routine, and pagination filters.",
      inputSchema: proposalListSchema,
      annotations: readAnnotations
    },
    async (query) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.listProposals(ctx.accessToken, query)
    ))
  );

  server.registerTool(
    "analyser.proposals.get",
    {
      title: "Get Analyser Proposal",
      description: "Get one analyser proposal including its content, evidence, status, and proposed action.",
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      annotations: readAnnotations
    },
    async ({ id }) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.getProposal(ctx.accessToken, id)
    ))
  );

  server.registerTool(
    "analyser.proposals.create",
    {
      title: "Create Analyser Proposal",
      description: "Create a proposal without user approval; agents must use proposals for uncertain operations.",
      inputSchema: proposalInputSchema,
      annotations: writeAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.createProposal(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.proposals.update",
    {
      title: "Update Analyser Proposal",
      description: "Update proposal content or mark it executed; agents cannot approve or reject, approval happens in the Workbench UI, and mark_executed only works for user-approved proposals with a recorded operation.",
      inputSchema: proposalUpdateSchema,
      annotations: writeAnnotations
    },
    async (input) => asMcpText(await runWithAnalyserAccount(ctx, async () => {
      if (input.action === "update_content") {
        const { id, action: _action, ...payload } = input;
        return client.updateProposalContent(ctx.accessToken, id, payload);
      }
      const { id, action: _action, ...payload } = input;
      return client.markProposalExecuted(ctx.accessToken, id, payload);
    }))
  );

  server.registerTool(
    "analyser.operations.record",
    {
      title: "Record Analyser Operation",
      description: "Record an operation after its domain mutation succeeded via existing Workbench tools; this does not perform the mutation.",
      inputSchema: operationInputSchema,
      annotations: idempotentWriteAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.recordOperation(ctx.accessToken, payload)
    ))
  );

  server.registerTool(
    "analyser.publications.record",
    {
      title: "Record Analyser Publication",
      description: "Idempotently record an agent publication of a summary or proposal to a Workbench note or artifact.",
      inputSchema: publicationInputSchema,
      annotations: idempotentWriteAnnotations
    },
    async (payload) => asMcpText(await runWithAnalyserAccount(
      ctx,
      () => client.recordPublication(ctx.accessToken, { ...payload, provenance: "agent" })
    ))
  );
}
