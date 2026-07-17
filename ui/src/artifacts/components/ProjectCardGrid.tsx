import { useMemo } from "react";
import { formatDateTime, normalizeProjectName } from "../../lib/format";
import type { ArtifactItem } from "../../types/models";
import type { ProjectOption } from "../types";
import { IcoFolder } from "./ArtifactsIcons";

interface ProjectCardGridProps {
  projectOptions: ProjectOption[];
  items: ArtifactItem[];
  onSelectAll: () => void;
  onSelectProject: (projectId: string) => void;
}

interface ProjectCardSummary {
  itemCount: number;
  latestUpdatedAt?: string;
}

function summarizeItems(items: ArtifactItem[]): ProjectCardSummary {
  const visibleItems = items.filter((item) => item.kind !== "folder");
  const latestUpdatedAt = items.reduce<string | undefined>((latest, item) => {
    if (!latest || Date.parse(item.updatedAt) > Date.parse(latest)) {
      return item.updatedAt;
    }
    return latest;
  }, undefined);
  return { itemCount: visibleItems.length, latestUpdatedAt };
}

function ProjectCard({
  title,
  summary,
  allProjects = false,
  onClick
}: {
  title: string;
  summary: ProjectCardSummary;
  allProjects?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={allProjects ? "va-project-card all-projects" : "va-project-card"}
      onClick={onClick}
    >
      <span className="va-project-card-icon" aria-hidden="true"><IcoFolder /></span>
      <span className="va-project-card-content">
        <strong>{title}</strong>
        <span>{summary.itemCount} {summary.itemCount === 1 ? "item" : "items"}</span>
        <small>{summary.latestUpdatedAt ? `Updated ${formatDateTime(summary.latestUpdatedAt)}` : "No updates"}</small>
      </span>
    </button>
  );
}

export function ProjectCardGrid({ projectOptions, items, onSelectAll, onSelectProject }: ProjectCardGridProps) {
  const summaries = useMemo(() => {
    const byProject = new Map<string, ArtifactItem[]>();
    for (const item of items) {
      const projectItems = byProject.get(item.projectId) ?? [];
      projectItems.push(item);
      byProject.set(item.projectId, projectItems);
    }
    return {
      all: summarizeItems(items),
      byProject: new Map([...byProject.entries()].map(([projectId, projectItems]) => [projectId, summarizeItems(projectItems)]))
    };
  }, [items]);

  return (
    <div className="va-project-card-grid">
      <ProjectCard title="All Projects" summary={summaries.all} allProjects onClick={onSelectAll} />
      {projectOptions.map((project) => (
        <ProjectCard
          key={project.projectId}
          title={normalizeProjectName(project.projectId, project.projectName)}
          summary={summaries.byProject.get(project.projectId) ?? { itemCount: 0 }}
          onClick={() => onSelectProject(project.projectId)}
        />
      ))}
    </div>
  );
}
