import type { Project, ProjectContextPack, ProjectContextSection } from "./types.js";

const CONTEXT_PRIORITY: ProjectContextSection[] = ["brief", "memory", "index", "relations", "summary", "links"];
const PROJECT_TRUNCATION_MARKER = "… [truncated]";
const PROJECT_DISPLAY_FIELD_PRIORITY: Array<keyof Pick<Project, "name" | "description">> = ["name", "description"];

export function clampContextMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 12_000;
  return Math.max(1_000, Math.min(50_000, Math.floor(value)));
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function sectionKey(section: ProjectContextSection): keyof ProjectContextPack {
  if (section === "memory") return "memories";
  if (section === "index") return "indexEntries";
  if (section === "summary") return "generatedSummary";
  return section;
}

function sectionHasContent(pack: ProjectContextPack, section: ProjectContextSection): boolean {
  const value = pack[sectionKey(section)];
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function withoutTruncatedSection(
  truncation: ProjectContextPack["truncation"],
  section: ProjectContextSection
): ProjectContextPack["truncation"] {
  return {
    ...truncation,
    truncatedSections: truncation.truncatedSections.filter((candidate) => candidate !== section)
  };
}

function truncatedProjectString(value: string, prefixLength: number): string {
  if (value.length <= prefixLength) return value;
  return `${value.slice(0, prefixLength)}${PROJECT_TRUNCATION_MARKER}`;
}

function fitProjectMetadata(
  project: Project,
  truncation: ProjectContextPack["truncation"],
  maxChars: number
): Project {
  const compact: Project = {
    id: project.id,
    name: truncatedProjectString(project.name, 0),
    description: truncatedProjectString(project.description, 0),
    status: project.status,
    ownerAccountId: project.ownerAccountId,
    ...(project.isFallbackDefault === undefined ? {} : { isFallbackDefault: project.isFallbackDefault }),
    ...(project.isUserDefault === undefined ? {} : { isUserDefault: project.isUserDefault }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };

  if (serializedLength({ project: compact, truncation }) > maxChars) {
    throw new Error("Immutable Project metadata exceeds the context budget");
  }

  for (const field of PROJECT_DISPLAY_FIELD_PRIORITY) {
    const original = project[field];
    const full = { ...compact, [field]: original };
    if (serializedLength({ project: full, truncation }) <= maxChars) {
      compact[field] = original;
      continue;
    }

    let low = 0;
    let high = original.length;
    while (low < high) {
      const midpoint = Math.ceil((low + high) / 2);
      const candidate = { ...compact, [field]: truncatedProjectString(original, midpoint) };
      if (serializedLength({ project: candidate, truncation }) <= maxChars) low = midpoint;
      else high = midpoint - 1;
    }
    compact[field] = truncatedProjectString(original, low);
  }

  return compact;
}

export function budgetProjectContext(pack: ProjectContextPack, requestedMaxChars: number): ProjectContextPack {
  const maxChars = clampContextMaxChars(requestedMaxChars);
  const initialTruncatedSections = CONTEXT_PRIORITY.filter((section) => sectionHasContent(pack, section));
  const truncation: ProjectContextPack["truncation"] = { maxChars, truncatedSections: initialTruncatedSections };
  const output: ProjectContextPack = {
    project: fitProjectMetadata(pack.project, truncation, maxChars),
    truncation
  };

  let lowerPriorityBlocked = false;
  const addSection = (section: ProjectContextSection): void => {
    const key = sectionKey(section);
    const value = pack[key];
    if (value === undefined) return;
    if (lowerPriorityBlocked) return;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        const candidate = { ...output, [key]: value };
        if (serializedLength(candidate) <= maxChars) {
          (output as unknown as Record<string, unknown>)[key] = value;
        }
        return;
      }

      const accepted: unknown[] = [];
      for (const item of value) {
        const candidate = { ...output, [key]: [...accepted, item] };
        if (serializedLength(candidate) > maxChars) break;
        accepted.push(item);
      }
      if (accepted.length > 0) (output as unknown as Record<string, unknown>)[key] = accepted;
      if (accepted.length < value.length) {
        lowerPriorityBlocked = true;
      } else {
        output.truncation = withoutTruncatedSection(output.truncation, section);
      }
      return;
    }
    const candidate = {
      ...output,
      [key]: value,
      truncation: withoutTruncatedSection(output.truncation, section)
    };
    if (serializedLength(candidate) <= maxChars) {
      (output as unknown as Record<string, unknown>)[key] = value;
      output.truncation = candidate.truncation;
    } else {
      lowerPriorityBlocked = true;
    }
  };

  for (const section of CONTEXT_PRIORITY) addSection(section);
  if (serializedLength(output) > maxChars) {
    throw new Error("Project context budget invariant violated");
  }
  return output;
}
