import { useEffect, useMemo, useRef, useState } from "react";
import { artifactsApi, imagesApi, projectsApi } from "../lib/api";
import type {
  ArtifactItem,
  ImageAssetRecord,
  ImageContextRef,
  ImageDefaultsResponse,
  ImageIntent,
  ImageJobRecord,
  ImageProvider,
  ImageQuality,
  ImageReferenceRecord,
  ImageSize,
  ProjectRecord
} from "../types/models";
import "./ImagesPage.css";

const intentLabels: Record<ImageIntent, string> = {
  create: "Create",
  refine: "Refine",
  edit: "Edit",
  context_update: "Context Update"
};

const contextNameStorageKey = "workbench.images.contextNames";

function readStoredContextNames(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(contextNameStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function assetLabel(asset: ImageAssetRecord): string {
  return `${asset.id.slice(0, 18)} / ${asset.width ?? "?"}x${asset.height ?? "?"}`;
}

type ImageHistoryGroup = {
  key: string;
  label: string;
  detail: string;
  jobs: ImageJobRecord[];
  updatedAt: string;
};

type ImagePreviewItem = {
  key: string;
  label: string;
  asset: ImageAssetRecord;
  job?: ImageJobRecord;
  kind: "source" | "result";
};

function compactText(value: string | undefined, maxLength = 96): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function contextRefLabel(ref: ImageContextRef): string {
  return compactText(ref.title || ref.path || ref.content || ref.id || ref.kind, 72) || ref.kind;
}

function contextInfoForJob(job: ImageJobRecord): { key: string; label: string; detail: string } {
  const refs = job.contextSnapshot?.refs ?? [];
  if (refs.length > 0) {
    const first = refs[0];
    const label = contextRefLabel(first);
    const detailParts = [
      first.kind,
      refs.length > 1 ? `+${refs.length - 1} refs` : undefined,
      compactText(job.contextSnapshot?.summary, 96)
    ].filter(Boolean);
    const key = refs
      .map((ref) => `${ref.kind}:${ref.id || ref.path || ref.title || compactText(ref.content, 64)}`)
      .join("|");
    return {
      key: `context:${key}`,
      label,
      detail: detailParts.join(" / ") || "Context"
    };
  }

  if (job.projectName || job.artifactPath || job.artifactTitle) {
    return {
      key: `artifact:${job.projectId || job.projectName || "default"}:${job.artifactPath || job.artifactTitle || ""}`,
      label: job.projectName ? `Project: ${job.projectName}` : "Artifacts",
      detail: compactText(job.artifactPath || job.artifactTitle, 96) || "Artifact context"
    };
  }

  const sourceAssetIds = Array.isArray(job.request.sourceAssetIds)
    ? job.request.sourceAssetIds.filter((id): id is string => typeof id === "string")
    : [];
  if (sourceAssetIds.length > 0) {
    return {
      key: `source:${sourceAssetIds.join("|")}`,
      label: "Source asset",
      detail: sourceAssetIds.map((id) => id.slice(0, 18)).join(", ")
    };
  }

  return {
    key: "context:none",
    label: "No explicit context",
    detail: "Prompt-only generations"
  };
}

export function ImagesPage() {
  const [defaults, setDefaults] = useState<ImageDefaultsResponse | undefined>();
  const [history, setHistory] = useState<ImageJobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<ImageJobRecord | undefined>();
  const [prompt, setPrompt] = useState("A polished product image for a modern workspace tool");
  const [instruction, setInstruction] = useState("");
  const [contextText, setContextText] = useState("");
  const [provider, setProvider] = useState<ImageProvider>("auto");
  const [model, setModel] = useState("");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [quality, setQuality] = useState<ImageQuality>("standard");
  const [count, setCount] = useState(1);
  const [intent, setIntent] = useState<ImageIntent>("create");
  const [references, setReferences] = useState<ImageReferenceRecord[]>([]);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [preserve, setPreserve] = useState<Array<"composition" | "subject" | "style" | "colors" | "text" | "layout">>([
    "subject",
    "composition"
  ]);
  const [saveToArtifacts, setSaveToArtifacts] = useState(false);
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [artifactItems, setArtifactItems] = useState<ArtifactItem[]>([]);
  const [artifactSettingsOpen, setArtifactSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [rightTab, setRightTab] = useState<"preview" | "history">("preview");
  const [contextNames, setContextNames] = useState<Record<string, string>>(() => readStoredContextNames());
  const [editingContextKey, setEditingContextKey] = useState("");
  const [contextNameDraft, setContextNameDraft] = useState("");
  const objectUrlsRef = useRef<Record<string, string>>({});

  const selectedSourceAsset = useMemo(() => {
    if (!sourceAssetId) return undefined;
    return history.flatMap((job) => job.assets).find((asset) => asset.id === sourceAssetId);
  }, [history, sourceAssetId]);

  const allHistoryAssets = useMemo(() => history.flatMap((job) => job.assets), [history]);

  const jobByAssetId = useMemo(() => {
    const map = new Map<string, ImageJobRecord>();
    for (const job of history) {
      for (const asset of job.assets) {
        map.set(asset.id, job);
      }
    }
    return map;
  }, [history]);

  const selectedJobSourceAssets = useMemo(() => {
    const sourceIds = selectedJob?.request?.sourceAssetIds;
    if (!Array.isArray(sourceIds)) return [];
    return sourceIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => allHistoryAssets.find((asset) => asset.id === id))
      .filter((asset): asset is ImageAssetRecord => Boolean(asset));
  }, [allHistoryAssets, selectedJob]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projectId, projects]
  );

  const modelOptions = useMemo(() => {
    if (!defaults?.availableModels) return [];
    if (provider === "auto") return [];
    return defaults.availableModels[provider] ?? [];
  }, [defaults, provider]);

  const artifactPathOptions = useMemo(() => {
    const directories = new Set<string>(["images/"]);
    for (const item of artifactItems) {
      const path = item.kind === "folder" ? item.path : item.parentPath;
      const normalized = path.replace(/^\/+/, "").replace(/\/?$/, "/");
      if (normalized && normalized !== "/") directories.add(normalized);
    }
    return [...directories].sort((a, b) => a.localeCompare(b));
  }, [artifactItems]);

  const historyGroups = useMemo<ImageHistoryGroup[]>(() => {
    const groups = new Map<string, ImageHistoryGroup>();
    for (const job of history) {
      const info = contextInfoForJob(job);
      const label = contextNames[info.key]?.trim() || info.label;
      const existing = groups.get(info.key);
      if (existing) {
        existing.jobs.push(job);
        if (new Date(job.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
          existing.updatedAt = job.updatedAt;
        }
      } else {
        groups.set(info.key, {
          ...info,
          label,
          jobs: [job],
          updatedAt: job.updatedAt
        });
      }
    }
    return [...groups.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [contextNames, history]);

  const refreshHistory = async () => {
    const loaded = await imagesApi.list(40);
    setHistory(loaded.items);
    setSelectedJob((current) => {
      if (!current) return loaded.items[0];
      return loaded.items.find((item) => item.jobId === current.jobId) ?? loaded.items[0];
    });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loadedDefaults = await imagesApi.defaults();
        if (cancelled) return;
        setDefaults(loadedDefaults);
        setProvider(loadedDefaults.defaults.provider);
        setModel(loadedDefaults.defaults.model ?? "");
        setSize(loadedDefaults.defaults.size);
        setQuality(loadedDefaults.defaults.quality);
        setCount(loadedDefaults.defaults.count);
        setSaveToArtifacts(loadedDefaults.defaults.saveToArtifacts);
        const [loadedProjects] = await Promise.all([
          projectsApi.list(undefined, undefined, 100).catch(() => ({ items: [] })),
          refreshHistory()
        ]);
        if (!cancelled) setProjects(loadedProjects.items);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load Images.");
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const url of Object.values(objectUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (provider === "auto") {
      setModel("");
      return;
    }
    const options = defaults?.availableModels?.[provider] ?? [];
    if (options.length > 0 && !options.some((option) => option.id === model)) {
      setModel(options[0].id);
    }
  }, [defaults, model, provider]);

  useEffect(() => {
    window.localStorage.setItem(contextNameStorageKey, JSON.stringify(contextNames));
  }, [contextNames]);

  useEffect(() => {
    if (!artifactSettingsOpen) return;
    let cancelled = false;
    void artifactsApi.tree(projectId || undefined)
      .then((items) => {
        if (!cancelled) setArtifactItems(items);
      })
      .catch(() => {
        if (!cancelled) setArtifactItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactSettingsOpen, projectId]);

  useEffect(() => {
    const assets = [...(selectedJob?.assets ?? []), ...selectedJobSourceAssets];
    for (const asset of assets) {
      if (objectUrlsRef.current[asset.id]) continue;
      void imagesApi.downloadAsset(asset.id).then((blob) => {
        const url = URL.createObjectURL(blob);
        objectUrlsRef.current[asset.id] = url;
        setAssetUrls((prev) => ({ ...prev, [asset.id]: url }));
      }).catch(() => undefined);
    }
    if (selectedSourceAsset && !objectUrlsRef.current[selectedSourceAsset.id]) {
      void imagesApi.downloadAsset(selectedSourceAsset.id).then((blob) => {
        const url = URL.createObjectURL(blob);
        objectUrlsRef.current[selectedSourceAsset.id] = url;
        setAssetUrls((prev) => ({ ...prev, [selectedSourceAsset.id]: url }));
      }).catch(() => undefined);
    }
  }, [selectedJob, selectedJobSourceAssets, selectedSourceAsset]);

  const uploadReference = async (file: File, purpose: "reference" | "source") => {
    setError("");
    const created = await imagesApi.uploadReference({ file, purpose, projectId: projectId || undefined });
    setReferences((prev) => [created, ...prev]);
    setSelectedReferenceIds((prev) => [...new Set([created.id, ...prev])]);
    if (purpose === "source") {
      setIntent("refine");
    }
  };

  const runGeneration = async () => {
    setIsLoading(true);
    setError("");
    try {
      const sourceAssetIds = sourceAssetId ? [sourceAssetId] : undefined;
      const contextRefs = contextText.trim()
        ? [{ kind: "freeform" as const, title: "User context", content: contextText.trim() }]
        : undefined;
      const result = await imagesApi.generate({
        intent,
        prompt,
        instruction: instruction || undefined,
        provider,
        model: model || undefined,
        size,
        quality,
        count,
        referenceImageIds: selectedReferenceIds,
        sourceAssetIds,
        contextRefs,
        preserve,
        saveToArtifacts,
        artifactTitle: artifactTitle || undefined,
        artifactPath: artifactPath || undefined,
        projectId: projectId || undefined,
        projectName: selectedProject?.name
      });
      setSelectedJob(result);
      await refreshHistory();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Image generation failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const saveAsset = async (asset: ImageAssetRecord) => {
    setError("");
    try {
      await imagesApi.saveArtifact(asset.id, {
        artifactTitle: artifactTitle || undefined,
        artifactPath: artifactPath || undefined,
        projectId: projectId || undefined,
        projectName: selectedProject?.name
      });
      await refreshHistory();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Artifact save failed.");
    }
  };

  const deleteHistoryJob = async (jobId: string) => {
    if (!window.confirm("Delete this image history item?")) return;
    setError("");
    try {
      await imagesApi.removeJob(jobId);
      const next = history.filter((job) => job.jobId !== jobId);
      setHistory(next);
      setSelectedJob((current) => {
        if (!current || current.jobId === jobId) return next[0];
        return next.some((job) => job.jobId === current.jobId) ? current : next[0];
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "History delete failed.");
    }
  };

  const togglePreserve = (value: typeof preserve[number]) => {
    setPreserve((prev) => prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]);
  };

  const renameContext = (key: string, value: string) => {
    setContextNames((prev) => {
      const next = { ...prev };
      if (value.trim()) {
        next[key] = value;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const startContextRename = (group: ImageHistoryGroup) => {
    setEditingContextKey(group.key);
    setContextNameDraft(contextNames[group.key] ?? group.label);
  };

  const commitContextRename = () => {
    if (!editingContextKey) return;
    renameContext(editingContextKey, contextNameDraft.trim());
    setEditingContextKey("");
    setContextNameDraft("");
  };

  const cancelContextRename = () => {
    setEditingContextKey("");
    setContextNameDraft("");
  };

  const currentAssets = selectedJob?.assets ?? [];
  const previewItems = useMemo(() => {
    const items: ImagePreviewItem[] = [];
    const sourceAssets = selectedJobSourceAssets.length > 0
      ? selectedJobSourceAssets
      : selectedSourceAsset
        ? [selectedSourceAsset]
        : [];
    sourceAssets.forEach((asset, index) => {
      items.push({
        key: `source-${asset.id}`,
        label: sourceAssets.length > 1 ? `Source ${index + 1}` : "Source",
        asset,
        job: jobByAssetId.get(asset.id),
        kind: "source"
      });
    });
    currentAssets.forEach((asset, index) => {
      items.push({
        key: `result-${asset.id}`,
        label: currentAssets.length > 1 ? `Result ${index + 1}` : "Latest Result",
        asset,
        job: selectedJob,
        kind: "result"
      });
    });
    return items;
  }, [currentAssets, jobByAssetId, selectedJob, selectedJobSourceAssets, selectedSourceAsset]);

  return (
    <div className="images-page">
      <section className="images-workbench">
        <aside className="images-control-panel">
          <header className="images-panel-header">
            <div>
              <p className="eyebrow">Image Generation</p>
            </div>
            <span className={defaults?.enabled === false ? "images-status off" : "images-status"}>
              {defaults?.enabled === false ? "Disabled" : "Ready"}
            </span>
          </header>

          {error ? <p className="images-error">{error}</p> : null}

          <div className="images-mode-row" aria-label="Image intent">
            {(Object.keys(intentLabels) as ImageIntent[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={intent === value}
                className={intent === value ? "active" : ""}
                onClick={() => setIntent(value)}
              >
                {intentLabels[value]}
              </button>
            ))}
          </div>

          <section className="images-form-section">
            <label className="images-field span-2">
              <span>Prompt</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
            </label>

            <label className="images-field span-2">
              <span>Instruction</span>
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                rows={3}
                placeholder="Keep the subject, improve lighting, update style..."
              />
            </label>

            <div className="images-grid-fields">
              <label className="images-field">
                <span>Provider</span>
                <select value={provider} onChange={(event) => setProvider(event.target.value as ImageProvider)}>
                  <option value="auto">Auto</option>
                  <option value="mock">Mock</option>
                  <option value="openai">OpenAI</option>
                  <option value="nanobanana">Nano Banana</option>
                </select>
              </label>
              <label className="images-field">
                <span>Model</span>
                <select value={model} disabled={provider === "auto"} onChange={(event) => setModel(event.target.value)}>
                  {provider === "auto" ? (
                    <option value="">Auto-selected by provider</option>
                  ) : modelOptions.length > 0 ? (
                    modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} / {option.id}
                      </option>
                    ))
                  ) : (
                    <option value="">Default model</option>
                  )}
                </select>
              </label>
              <label className="images-field">
                <span>Size</span>
                <select value={size} onChange={(event) => setSize(event.target.value as ImageSize)}>
                  <option value="1024x1024">1024x1024</option>
                  <option value="1024x1536">1024x1536</option>
                  <option value="1536x1024">1536x1024</option>
                  <option value="auto">Auto</option>
                </select>
              </label>
              <label className="images-field">
                <span>Quality</span>
                <select value={quality} onChange={(event) => setQuality(event.target.value as ImageQuality)}>
                  <option value="draft">Draft</option>
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="images-field">
                <span>Count</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={count}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              </label>
            </div>
          </section>

          <section className="images-source-section">
            <div className="images-section-title">
              <strong>Reference Images</strong>
              <small>{references.length} uploaded</small>
            </div>
            <div className="images-upload-row">
              <label className="images-upload-button">
                Add reference
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadReference(file, "reference");
                  event.currentTarget.value = "";
                }} />
              </label>
              <label className="images-upload-button">
                Add source
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadReference(file, "source");
                  event.currentTarget.value = "";
                }} />
              </label>
            </div>
            {references.length > 0 ? (
              <div className="images-reference-list">
                {references.map((reference) => (
                  <label key={reference.id}>
                    <input
                      type="checkbox"
                      checked={selectedReferenceIds.includes(reference.id)}
                      onChange={(event) => {
                        setSelectedReferenceIds((prev) =>
                          event.target.checked ? [...prev, reference.id] : prev.filter((id) => id !== reference.id)
                        );
                      }}
                    />
                    <span>{reference.purpose}</span>
                    <small>{formatBytes(reference.sizeBytes)}</small>
                  </label>
                ))}
              </div>
            ) : null}
          </section>

          <label className="images-field">
            <span>Source Asset</span>
            <select value={sourceAssetId} onChange={(event) => setSourceAssetId(event.target.value)}>
              <option value="">No existing source asset</option>
              {history.flatMap((job) => job.assets).map((asset) => (
                <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>
              ))}
            </select>
          </label>

          <section className="images-source-section">
            <div className="images-section-title">
              <strong>Preserve</strong>
            </div>
            <div className="images-chip-row">
              {(["subject", "composition", "style", "colors", "text", "layout"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={preserve.includes(item) ? "active" : ""}
                  onClick={() => togglePreserve(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </section>

          <label className="images-field">
            <span>Context</span>
            <textarea
              value={contextText}
              onChange={(event) => setContextText(event.target.value)}
              rows={4}
              placeholder="Paste project direction, brand notes, or update requirements."
            />
          </label>

          <details
            className="images-source-section images-advanced-section"
            open={artifactSettingsOpen}
            onToggle={(event) => setArtifactSettingsOpen(event.currentTarget.open)}
          >
            <summary>
              <strong>Artifacts</strong>
              <small>Advanced save settings</small>
            </summary>
            <label className="images-check">
              <input type="checkbox" checked={saveToArtifacts} onChange={(event) => setSaveToArtifacts(event.target.checked)} />
              Auto-save generated assets
            </label>
            <label className="images-field">
              <span>Artifact Title</span>
              <input value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} />
            </label>
            <label className="images-field">
              <span>Project</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">Default Project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="images-field">
              <span>Artifact Path</span>
              <input
                list="images-artifact-path-options"
                value={artifactPath}
                onChange={(event) => setArtifactPath(event.target.value)}
                placeholder="images/hero.png"
              />
              <datalist id="images-artifact-path-options">
                {artifactPathOptions.map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
            </label>
          </details>

          <button className="images-primary-button" type="button" onClick={() => void runGeneration()} disabled={isLoading || !prompt.trim()}>
            {isLoading ? "Generating..." : intent === "create" ? "Generate" : "Run Update"}
          </button>
        </aside>

        <main className="images-result-panel">
          <div className="images-right-tabs" role="tablist" aria-label="Image output">
            <button
              type="button"
              className={rightTab === "preview" ? "active" : ""}
              aria-selected={rightTab === "preview"}
              role="tab"
              onClick={() => setRightTab("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className={rightTab === "history" ? "active" : ""}
              aria-selected={rightTab === "history"}
              role="tab"
              onClick={() => setRightTab("history")}
            >
              History
              <span>{historyGroups.length}</span>
            </button>
          </div>

          {rightTab === "preview" ? (
            <section className="images-preview-area">
              {previewItems.length > 0 || isLoading ? (
                  <div className="images-preview-timeline">
                    {isLoading ? (
                      <article className="images-single-preview images-generating-preview">
                        <div className="images-single-preview-head">
                          <div>
                            <strong>Generating</strong>
                            <small>{count} image{count === 1 ? "" : "s"} in progress</small>
                          </div>
                        </div>
                        <div className="images-generating-frame">
                          <div className="images-generating-spinner" aria-hidden="true" />
                          <strong>Generating image...</strong>
                          <span>New result tiles will appear here when the job completes.</span>
                        </div>
                        <dl className="images-preview-meta">
                          <div className="span-2">
                            <dt>Prompt</dt>
                            <dd>{prompt}</dd>
                          </div>
                          {instruction ? (
                            <div className="span-2">
                              <dt>Instruction</dt>
                              <dd>{instruction}</dd>
                            </div>
                          ) : null}
                          {contextText.trim() ? (
                            <div className="span-2">
                              <dt>Context</dt>
                              <dd>{contextText.trim()}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>Mode</dt>
                            <dd>{intentLabels[intent]} / running</dd>
                          </div>
                          <div>
                            <dt>Provider</dt>
                            <dd>{provider}{model ? ` / ${model}` : ""}</dd>
                          </div>
                        </dl>
                      </article>
                    ) : null}
                    {previewItems.map(({ key, label, asset, job, kind }) => {
                      const contextInfo = job ? contextInfoForJob(job) : undefined;
                      const contextLabel = contextInfo ? contextNames[contextInfo.key]?.trim() || contextInfo.label : undefined;
                      return (
                      <article key={key} className="images-single-preview">
                        <div className="images-single-preview-head">
                          <div>
                            <strong>{label}</strong>
                            <small>{asset.width ?? "?"}x{asset.height ?? "?"} / {formatBytes(asset.sizeBytes)}</small>
                          </div>
                        </div>
                        <div className="images-single-image-frame">
                          {assetUrls[asset.id] ? (
                            <img src={assetUrls[asset.id]} alt={label} />
                          ) : (
                            <div className="images-placeholder" />
                          )}
                        </div>
                        {job ? (
                          <dl className="images-preview-meta">
                            <div className="span-2">
                              <dt>{kind === "source" ? "Source Prompt" : "Prompt"}</dt>
                              <dd>{job.prompt}</dd>
                            </div>
                            {job.instruction ? (
                              <div className="span-2">
                                <dt>Instruction</dt>
                                <dd>{job.instruction}</dd>
                              </div>
                            ) : null}
                            {contextInfo && contextInfo.key !== "context:none" ? (
                              <div className="span-2">
                                <dt>Context</dt>
                                <dd>{contextLabel}{contextInfo.detail ? ` / ${contextInfo.detail}` : ""}</dd>
                              </div>
                            ) : null}
                            <div>
                              <dt>Mode</dt>
                              <dd>{intentLabels[job.intent]} / {job.status}</dd>
                            </div>
                            <div>
                              <dt>Provider</dt>
                              <dd>{job.provider} / {job.model}</dd>
                            </div>
                            <div>
                              <dt>Created</dt>
                              <dd>{formatDateTime(job.createdAt)}</dd>
                            </div>
                            <div>
                              <dt>Asset</dt>
                              <dd>#{asset.indexInJob + 1} / {asset.id.slice(0, 18)}</dd>
                            </div>
                          </dl>
                        ) : (
                          <p className="images-preview-note">Source asset selected for refinement.</p>
                        )}
                        <div className="images-card-actions">
                          <button type="button" onClick={() => void imagesApi.downloadAsset(asset.id, true).then((blob) => {
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = `${asset.id}.png`;
                            link.click();
                            setTimeout(() => URL.revokeObjectURL(url), 60000);
                          })}>Download</button>
                          <button type="button" onClick={() => void saveAsset(asset)}>Save to Artifacts</button>
                          <button type="button" onClick={() => {
                            setSourceAssetId(asset.id);
                            setIntent("refine");
                          }}>Use as Source</button>
                        </div>
                      </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="images-empty-state">
                    <h3>No image selected</h3>
                    <p>Generate a new image, upload a reference, or choose a previous asset to refine.</p>
                  </div>
                )}
              </section>
          ) : (
            <section className="images-history-panel">
              <div className="images-section-title">
                <strong>History</strong>
                <button type="button" onClick={() => void refreshHistory()}>Refresh</button>
              </div>
              <div className="images-history-groups">
                {historyGroups.length === 0 ? (
                  <p>No generations yet.</p>
                ) : historyGroups.map((group) => (
                  <section key={group.key} className="images-history-group">
                    <header>
                      <div className="images-context-name-field">
                        {editingContextKey === group.key ? (
                          <input
                            autoFocus
                            value={contextNameDraft}
                            onBlur={commitContextRename}
                            onChange={(event) => setContextNameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitContextRename();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelContextRename();
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="images-context-name-button"
                            title="Rename context"
                            onClick={() => startContextRename(group)}
                          >
                            {group.label}
                          </button>
                        )}
                        <small>{group.detail}</small>
                      </div>
                      <span>{group.jobs.length}</span>
                    </header>
                    <div className="images-history-list">
                      {group.jobs.map((job) => (
                        <div key={job.jobId} className={selectedJob?.jobId === job.jobId ? "images-history-item active" : "images-history-item"}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedJob(job);
                              setRightTab("preview");
                            }}
                          >
                            <strong>{job.prompt}</strong>
                            <span>{intentLabels[job.intent]} / {job.status}</span>
                            <small>{formatDateTime(job.updatedAt)}</small>
                          </button>
                          <button
                            className="images-history-delete"
                            type="button"
                            aria-label={`Delete ${job.prompt}`}
                            onClick={() => void deleteHistoryJob(job.jobId)}
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          )}
        </main>
      </section>
    </div>
  );
}
