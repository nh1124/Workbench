import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { notesApi, projectsApi } from "../lib/api";
import { normalizeProjectName } from "../lib/format";
import { pushNotification } from "../lib/notificationService";
import "./QuickNoteModal.css";

interface QuickNoteModalProps {
  open: boolean;
  onClose: () => void;
  standalone?: boolean;
}

interface QuickNoteDraft {
  title: string;
  content: string;
  projectId: string;
  tags: string[];
}

interface ProjectOption {
  projectId: string;
  projectName?: string;
}

const DEFAULT_PROJECT_ID = "general";
const emptyDraft: QuickNoteDraft = {
  title: "",
  content: "",
  projectId: DEFAULT_PROJECT_ID,
  tags: []
};

function isAuthErrorMessage(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("missing bearer token") || value.includes("unauthorized") || value.includes("forbidden");
}

function mergeProjectOptions(...groups: ProjectOption[][]): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  for (const group of groups) {
    for (const option of group) {
      const id = option.projectId?.trim();
      if (!id) {
        continue;
      }
      const prev = map.get(id);
      map.set(id, {
        projectId: id,
        projectName: option.projectName?.trim() || prev?.projectName
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    normalizeProjectName(a.projectId, a.projectName).localeCompare(
      normalizeProjectName(b.projectId, b.projectName)
    )
  );
}

function inferQuickTitle(content: string): string {
  const line = content
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (line) {
    return line.slice(0, 60);
  }
  const now = new Date();
  const stamp = now.toLocaleString("ja-JP", { hour12: false });
  return `Quick Note ${stamp}`;
}

export function QuickNoteModal({ open, onClose, standalone = false }: QuickNoteModalProps) {
  const [draft, setDraft] = useState<QuickNoteDraft>(emptyDraft);
  const [defaultProject, setDefaultProject] = useState<ProjectOption>({
    projectId: DEFAULT_PROJECT_ID,
    projectName: "general"
  });
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([
    { projectId: DEFAULT_PROJECT_ID, projectName: "general" }
  ]);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const contentInputRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedProjectName = useMemo(() => {
    return projectOptions.find((option) => option.projectId === draft.projectId)?.projectName;
  }, [draft.projectId, projectOptions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft((prev) => ({
      ...emptyDraft,
      projectId: defaultProject.projectId || DEFAULT_PROJECT_ID
    }));
    setTagInput("");
    setError(null);

    const loadProjects = async () => {
      try {
        const [defaultSelection, result] = await Promise.all([
          projectsApi.getDefault().catch(() => null),
          projectsApi.list(undefined, undefined, 200).catch(() => ({ items: [] }))
        ]);
        const resolvedDefault: ProjectOption = defaultSelection
          ? { projectId: defaultSelection.project.id, projectName: defaultSelection.project.name }
          : { projectId: DEFAULT_PROJECT_ID, projectName: "general" };

        setDefaultProject(resolvedDefault);

        const serviceOptions = result.items.map((project) => ({
          projectId: project.id,
          projectName: project.name
        }));
        const mergedOptions = mergeProjectOptions(
          [{ projectId: DEFAULT_PROJECT_ID, projectName: "general" }],
          [resolvedDefault],
          serviceOptions
        );
        setProjectOptions(mergedOptions);
        setDraft((prev) => ({
          ...prev,
          projectId: resolvedDefault.projectId
        }));
      } catch {
        setProjectOptions([{ projectId: DEFAULT_PROJECT_ID, projectName: "general" }]);
        setDefaultProject({ projectId: DEFAULT_PROJECT_ID, projectName: "general" });
        setDraft((prev) => ({ ...prev, projectId: DEFAULT_PROJECT_ID }));
      }
    };

    void loadProjects();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const focusTimer = window.setTimeout(() => {
      contentInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  if (!open) {
    return null;
  }

  const addTag = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
      setTagInput("");
      return;
    }
    setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
    setTagInput("");
  };

  const removeTag = (value: string) => {
    setDraft((prev) => ({ ...prev, tags: prev.tags.filter((tag) => tag !== value) }));
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(tagInput);
    }
    if (event.key === "Backspace" && !tagInput && draft.tags.length > 0) {
      setDraft((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  };

  const close = () => {
    if (isSaving) {
      return;
    }
    setError(null);
    onClose();
  };

  const handleSave = async () => {
    if (!draft.title.trim() && !draft.content.trim()) {
      setError("Title or content is required.");
      return;
    }

    setError(null);
    setIsSaving(true);

    try {
      const title = draft.title.trim() || inferQuickTitle(draft.content);
      const projectId = draft.projectId.trim() || DEFAULT_PROJECT_ID;
      await notesApi.create({
        title,
        content: draft.content,
        projectId,
        projectName: selectedProjectName?.trim() || undefined,
        tags: draft.tags
      });
      pushNotification({
        title: "Quick Note",
        message: "Saved successfully.",
        level: "success"
      });
      onClose();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Unable to save quick note.";
      setError(isAuthErrorMessage(message) ? "Sign-in is required to save notes." : message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleModalKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!isSaving) {
        void handleSave();
      }
    }
  };

  const modalContent = (
    <section
      className={standalone ? "quick-note-modal quick-note-modal-standalone" : "quick-note-modal"}
      role="dialog"
      aria-modal="true"
      aria-label="Quick note"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleModalKeyDown}
    >
      <header className="quick-note-head">
        <div>
          <h2>Quick Note</h2>
          <p>Capture now with Win + Alt + N</p>
        </div>
        <button type="button" className="quick-note-close" onClick={close} aria-label="Close quick note">
          ×
        </button>
      </header>

      <div className="quick-note-body">
        {error ? <p className="quick-note-error">{error}</p> : null}

        <label>
          Title (optional)
          <input
            value={draft.title}
            onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            placeholder="Quick note title"
          />
        </label>

        <label>
          Content
          <textarea
            ref={contentInputRef}
            rows={8}
            value={draft.content}
            onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
            placeholder="Capture your note..."
          />
        </label>

        <label>
          Link to Project
          <select
            value={draft.projectId}
            onChange={(event) => setDraft((prev) => ({ ...prev, projectId: event.target.value }))}
          >
            {projectOptions.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {normalizeProjectName(project.projectId, project.projectName)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Tags
          <div className="quick-note-tags-input" onClick={() => document.getElementById("quick-note-tag-input")?.focus()}>
            {draft.tags.map((tag) => (
              <span key={tag} className="quick-note-tag-chip">
                {tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              id="quick-note-tag-input"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={handleTagInputKeyDown}
              onBlur={() => addTag(tagInput)}
              placeholder={draft.tags.length === 0 ? "Add tag and press Enter..." : "Add tag"}
            />
          </div>
        </label>
      </div>

      <footer className="quick-note-foot">
        <button type="button" className="ghost-button" onClick={close} disabled={isSaving}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Note"}
        </button>
      </footer>
    </section>
  );

  if (standalone) {
    return <div className="quick-note-window-shell">{modalContent}</div>;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={close}>
      {modalContent}
    </div>
  );
}
