import type { ProjectContextPack, ProjectContextSection } from "./types.js";

const CONTEXT_PRIORITY: ProjectContextSection[] = ["brief", "memory", "index", "relations", "summary", "links"];

export function clampContextMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 12_000;
  return Math.max(1_000, Math.min(50_000, Math.floor(value)));
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

export function budgetProjectContext(pack: ProjectContextPack, requestedMaxChars: number): ProjectContextPack {
  const maxChars = clampContextMaxChars(requestedMaxChars);
  const output: ProjectContextPack = {
    project: pack.project,
    truncation: { maxChars, truncatedSections: [] }
  };

  let lowerPriorityBlocked = false;
  const addSection = (section: ProjectContextSection): void => {
    const key = section === "memory" ? "memories" : section === "index" ? "indexEntries" :
      section === "summary" ? "generatedSummary" : section;
    const value = pack[key as keyof ProjectContextPack];
    if (value === undefined) return;
    const hasContent = Array.isArray(value) ? value.length > 0 : true;
    if (lowerPriorityBlocked) {
      if (hasContent) output.truncation.truncatedSections.push(section);
      return;
    }
    if (Array.isArray(value)) {
      const accepted: unknown[] = [];
      for (const item of value) {
        const candidate = { ...output, [key]: [...accepted, item] };
        if (serializedLength(candidate) > maxChars) break;
        accepted.push(item);
      }
      if (accepted.length > 0 || value.length === 0) (output as unknown as Record<string, unknown>)[key] = accepted;
      if (accepted.length < value.length) {
        output.truncation.truncatedSections.push(section);
        lowerPriorityBlocked = true;
      }
      return;
    }
    const candidate = { ...output, [key]: value };
    if (serializedLength(candidate) <= maxChars) {
      (output as unknown as Record<string, unknown>)[key] = value;
    } else {
      output.truncation.truncatedSections.push(section);
      lowerPriorityBlocked = true;
    }
  };

  for (const section of CONTEXT_PRIORITY) addSection(section);
  return output;
}
