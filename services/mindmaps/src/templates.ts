import { randomUUID } from "node:crypto";
import type { MindmapDocumentBody, MindmapMode, MindmapNode } from "./types.js";

function node(title: string, children: MindmapNode[] = [], note?: string): MindmapNode {
  return {
    id: randomUUID(),
    title,
    ...(note ? { note } : {}),
    ...(children.length > 0 ? { children } : {})
  };
}

export function createDefaultMindmapBody(
  title: string,
  mode: MindmapMode,
  template?: "blank" | "mindmap" | "logical_tree"
): MindmapDocumentBody {
  const trimmedTitle = title.trim() || (mode === "logical_tree" ? "Logical Tree" : "Mindmap");
  if (template === "blank") {
    return {
      root: node(trimmedTitle),
      layout: { direction: "right" },
      theme: { accentColor: mode === "logical_tree" ? "#2563eb" : "#16a34a" },
      metadata: { template: "blank" }
    };
  }

  if (mode === "logical_tree") {
    return {
      root: node(trimmedTitle, [
        node("Issue", [node("Factor A"), node("Factor B")]),
        node("Hypothesis", [node("Evidence"), node("Counterpoint")]),
        node("Action", [node("Next check"), node("Owner")])
      ]),
      layout: { direction: "right" },
      theme: { accentColor: "#2563eb" },
      metadata: { template: "logical_tree" }
    };
  }

  return {
    root: node(trimmedTitle, [
      node("Idea", [node("Detail")]),
      node("Question", [node("Option")]),
      node("Next", [node("Action")])
    ]),
    layout: { direction: "right" },
    theme: { accentColor: "#16a34a" },
    metadata: { template: "mindmap" }
  };
}
