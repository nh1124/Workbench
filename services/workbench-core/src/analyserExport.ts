import { createHash } from "node:crypto";
import { z } from "zod";
import {
  analyserClient,
  artifactsClient,
  InternalServiceError,
  notesClient
} from "./internalClients.js";

const resourceRefSchema = z.object({
  service: z.string().trim().min(1),
  resourceType: z.string().trim().min(1),
  resourceId: z.string().trim().min(1),
  pathSnapshot: z.string().optional()
}).strict();

const exportInputSchema = z.object({
  sourceKind: z.enum(["summary", "proposal"]),
  sourceId: z.string().uuid(),
  targetKind: z.enum(["note", "artifact"]),
  projectId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  path: z.string().trim().min(1).max(2_000).optional()
}).strict().superRefine((value, context) => {
  if (value.targetKind !== "artifact" && value.path !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["path"],
      message: "path is only supported for Artifact exports"
    });
  }
});

const sourceSchema = z.object({
  title: z.string().min(1),
  bodyMarkdown: z.string(),
  evidenceRefs: z.array(resourceRefSchema).default([]),
  status: z.enum(["open", "approved", "rejected", "executed", "superseded"]).optional()
}).passthrough();

const publicationSchema = z.object({
  id: z.string().min(1),
  sourceKind: z.enum(["summary", "proposal"]),
  sourceId: z.string().min(1),
  targetKind: z.enum(["note", "artifact"]),
  targetId: z.string().min(1),
  targetRef: resourceRefSchema.optional(),
  contentHash: z.string().min(1),
  provenance: z.enum(["ui", "agent"]),
  createdAt: z.string().optional()
}).passthrough();

const findPublicationResultSchema = z.object({
  publication: publicationSchema.nullable()
}).passthrough();

const recordPublicationResultSchema = z.object({
  publication: publicationSchema,
  created: z.boolean()
}).passthrough();

export type AnalyserExportInput = z.infer<typeof exportInputSchema>;
export type AnalyserExportPublication = z.infer<typeof publicationSchema>;

export type AnalyserExportResult = {
  publication: AnalyserExportPublication;
  created: boolean;
  target: {
    kind: "note" | "artifact";
    id: string;
    ref?: z.infer<typeof resourceRefSchema>;
  };
};

export type AnalyserExportDependencies = {
  analyserClient: Pick<typeof analyserClient, "getSummary" | "getProposal" | "findPublication" | "recordPublication">;
  notesClient: Pick<typeof notesClient, "create">;
  artifactsClient: Pick<typeof artifactsClient, "createNote">;
};

const defaultDependencies: AnalyserExportDependencies = {
  analyserClient,
  notesClient,
  artifactsClient
};

type AnalyserExportAuthContext = {
  accessToken: string;
};

function exportError(status: number, code: string, message: string): InternalServiceError {
  return new InternalServiceError("analyser", status, JSON.stringify({ message, code }));
}

function parseExportInput(input: unknown): AnalyserExportInput {
  const parsed = exportInputSchema.safeParse(input);
  if (!parsed.success) {
    throw exportError(400, "INVALID_ANALYSER_EXPORT", "Invalid Analyser export input");
  }
  return parsed.data;
}

function parseServiceResult<T>(schema: z.ZodType<T>, value: unknown, service: "analyser" | "notes" | "artifacts"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InternalServiceError(
      service,
      502,
      JSON.stringify({ message: `Invalid ${service} response during Analyser export`, code: "INVALID_SERVICE_RESPONSE" })
    );
  }
  return parsed.data;
}

function evidenceLine(ref: z.infer<typeof resourceRefSchema>): string {
  const base = `${ref.service}/${ref.resourceType}/${ref.resourceId}`;
  return ref.pathSnapshot ? `- ${base} (${ref.pathSnapshot})` : `- ${base}`;
}

function buildContent(
  title: string,
  bodyMarkdown: string,
  evidenceRefs: Array<z.infer<typeof resourceRefSchema>>,
  sourceKind: "summary" | "proposal",
  sourceId: string
): string {
  return [
    `# ${title}`,
    "",
    bodyMarkdown,
    "",
    "## Evidence",
    "",
    ...evidenceRefs.map(evidenceLine),
    "",
    `Exported from Analyser ${sourceKind} ${sourceId}`
  ].join("\n");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "analyser-export";
}

function defaultArtifactPath(title: string): string {
  return `analyser/exports/${new Date().toISOString().slice(0, 10)}-${slug(title)}.md`;
}

function targetId(value: unknown, service: "notes" | "artifacts"): string {
  const direct = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
  if (typeof direct === "string" && direct.trim()) return direct;
  const item = value && typeof value === "object" ? (value as { item?: unknown }).item : undefined;
  const nested = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
  if (typeof nested === "string" && nested.trim()) return nested;
  throw new InternalServiceError(
    service,
    502,
    JSON.stringify({ message: `Created ${service} target has no id`, code: "INVALID_SERVICE_RESPONSE" })
  );
}

function targetPath(value: unknown): string | undefined {
  const direct = value && typeof value === "object" ? (value as { path?: unknown }).path : undefined;
  if (typeof direct === "string" && direct.trim()) return direct;
  const item = value && typeof value === "object" ? (value as { item?: unknown }).item : undefined;
  const nested = item && typeof item === "object" ? (item as { path?: unknown }).path : undefined;
  return typeof nested === "string" && nested.trim() ? nested : undefined;
}

function resultFromPublication(publication: AnalyserExportPublication, created: boolean): AnalyserExportResult {
  return {
    publication,
    created,
    target: {
      kind: publication.targetKind,
      id: publication.targetId,
      ...(publication.targetRef ? { ref: publication.targetRef } : {})
    }
  };
}

export async function exportAnalyserRecord(
  authContext: AnalyserExportAuthContext,
  rawInput: unknown,
  deps: AnalyserExportDependencies = defaultDependencies
): Promise<AnalyserExportResult> {
  const input = parseExportInput(rawInput);
  const token = authContext.accessToken;
  const sourceValue = input.sourceKind === "summary"
    ? await deps.analyserClient.getSummary(token, input.sourceId)
    : await deps.analyserClient.getProposal(token, input.sourceId);
  const source = parseServiceResult(sourceSchema, sourceValue, "analyser");

  if (input.sourceKind === "proposal" && source.status !== "approved" && source.status !== "executed") {
    throw exportError(
      409,
      "ANALYSER_PROPOSAL_NOT_DURABLE",
      "Only approved or executed Analyser proposals can be exported"
    );
  }

  const title = input.title ?? source.title;
  const content = buildContent(title, source.bodyMarkdown, source.evidenceRefs ?? [], input.sourceKind, input.sourceId);
  const contentHash = createHash("sha256").update(`${input.targetKind}\n${content}`).digest("hex");
  const findResult = parseServiceResult(
    findPublicationResultSchema,
    await deps.analyserClient.findPublication(token, {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      targetKind: input.targetKind,
      contentHash
    }),
    "analyser"
  );
  if (findResult.publication) return resultFromPublication(findResult.publication, false);

  let createdTarget: unknown;
  let createdTargetId: string;
  let ref: z.infer<typeof resourceRefSchema>;
  if (input.targetKind === "note") {
    createdTarget = await deps.notesClient.create(token, {
      title,
      content,
      ...(input.projectId ? { projectId: input.projectId } : {})
    });
    createdTargetId = targetId(createdTarget, "notes");
    ref = { service: "notes", resourceType: "note", resourceId: createdTargetId };
  } else {
    const path = input.path ?? defaultArtifactPath(title);
    createdTarget = await deps.artifactsClient.createNote(token, {
      title,
      path,
      contentMarkdown: content,
      ...(input.projectId ? { projectId: input.projectId } : {})
    });
    createdTargetId = targetId(createdTarget, "artifacts");
    ref = {
      service: "artifacts",
      resourceType: "artifact_item",
      resourceId: createdTargetId,
      pathSnapshot: targetPath(createdTarget) ?? path
    };
  }

  const recorded = parseServiceResult(
    recordPublicationResultSchema,
    await deps.analyserClient.recordPublication(token, {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      targetKind: input.targetKind,
      targetId: createdTargetId,
      targetRef: ref,
      contentHash,
      provenance: "ui"
    }),
    "analyser"
  );
  return resultFromPublication(recorded.publication, recorded.created);
}
