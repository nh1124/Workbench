import { useEffect, useMemo, useRef, useState } from "react";
import { imagesApi } from "../lib/api";
import type {
  ImageAssetRecord,
  ImageDefaultsResponse,
  ImageIntent,
  ImageJobRecord,
  ImageProvider,
  ImageQuality,
  ImageReferenceRecord,
  ImageSize
} from "../types/models";
import "./ImagesPage.css";

const intentLabels: Record<ImageIntent, string> = {
  create: "Create",
  refine: "Refine",
  edit: "Edit",
  context_update: "Context Update"
};

type ControlTab = "compose" | "sources" | "context" | "export";

const controlTabs: Array<{ id: ControlTab; label: string }> = [
  { id: "compose", label: "Compose" },
  { id: "sources", label: "Sources" },
  { id: "context", label: "Context" },
  { id: "export", label: "Export" }
];

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

export function ImagesPage() {
  const [defaults, setDefaults] = useState<ImageDefaultsResponse | undefined>();
  const [history, setHistory] = useState<ImageJobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<ImageJobRecord | undefined>();
  const [prompt, setPrompt] = useState("A polished product image for a modern workspace tool");
  const [instruction, setInstruction] = useState("");
  const [contextText, setContextText] = useState("");
  const [provider, setProvider] = useState<ImageProvider>("auto");
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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [controlTab, setControlTab] = useState<ControlTab>("compose");
  const objectUrlsRef = useRef<Record<string, string>>({});

  const selectedSourceAsset = useMemo(() => {
    if (!sourceAssetId) return undefined;
    return history.flatMap((job) => job.assets).find((asset) => asset.id === sourceAssetId);
  }, [history, sourceAssetId]);

  const refreshHistory = async () => {
    const loaded = await imagesApi.list(40);
    setHistory(loaded.items);
    setSelectedJob((current) => {
      if (!current) return loaded.items[0];
      return loaded.items.find((item) => item.jobId === current.jobId) ?? current;
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
        setSize(loadedDefaults.defaults.size);
        setQuality(loadedDefaults.defaults.quality);
        setCount(loadedDefaults.defaults.count);
        setSaveToArtifacts(loadedDefaults.defaults.saveToArtifacts);
        await refreshHistory();
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
    const assets = selectedJob?.assets ?? [];
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
  }, [selectedJob, selectedSourceAsset]);

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
        projectId: projectId || undefined
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
        projectId: projectId || undefined
      });
      await refreshHistory();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Artifact save failed.");
    }
  };

  const togglePreserve = (value: typeof preserve[number]) => {
    setPreserve((prev) => prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]);
  };

  const currentAssets = selectedJob?.assets ?? [];

  return (
    <div className="images-page">
      <section className="images-workbench">
        <aside className="images-control-panel">
          <header className="images-panel-header">
            <div>
              <p className="eyebrow">Image Generation</p>
              <h2>Generate and refine images</h2>
            </div>
            <span className={defaults?.enabled === false ? "images-status off" : "images-status"}>
              {defaults?.enabled === false ? "Disabled" : "Ready"}
            </span>
          </header>

          {error ? <p className="images-error">{error}</p> : null}

          <div className="images-intent-tabs" role="tablist" aria-label="Image intent">
            {(Object.keys(intentLabels) as ImageIntent[]).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={intent === value}
                className={intent === value ? "active" : ""}
                onClick={() => setIntent(value)}
              >
                {intentLabels[value]}
              </button>
            ))}
          </div>

          <div className="images-control-tabs" role="tablist" aria-label="Image controls">
            {controlTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={controlTab === tab.id}
                className={controlTab === tab.id ? "active" : ""}
                onClick={() => setControlTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="images-tab-panel">
            {controlTab === "compose" ? (
              <>
                <label className="images-field">
                  <span>Prompt</span>
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
                </label>

                <label className="images-field">
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
                      max={4}
                      value={count}
                      onChange={(event) => setCount(Number(event.target.value))}
                    />
                  </label>
                </div>
              </>
            ) : null}

            {controlTab === "sources" ? (
              <>
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
              </>
            ) : null}

            {controlTab === "context" ? (
              <label className="images-field">
                <span>Context</span>
                <textarea
                  value={contextText}
                  onChange={(event) => setContextText(event.target.value)}
                  rows={8}
                  placeholder="Paste project direction, brand notes, or update requirements."
                />
              </label>
            ) : null}

            {controlTab === "export" ? (
              <section className="images-source-section">
                <div className="images-section-title">
                  <strong>Artifacts</strong>
                </div>
                <label className="images-check">
                  <input type="checkbox" checked={saveToArtifacts} onChange={(event) => setSaveToArtifacts(event.target.checked)} />
                  Auto-save generated assets
                </label>
                <label className="images-field">
                  <span>Artifact Title</span>
                  <input value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} />
                </label>
                <label className="images-field">
                  <span>Artifact Path</span>
                  <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} placeholder="images/hero.png" />
                </label>
                <label className="images-field">
                  <span>Project ID</span>
                  <input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="default" />
                </label>
              </section>
            ) : null}
          </div>

          <button className="images-primary-button" type="button" onClick={() => void runGeneration()} disabled={isLoading || !prompt.trim()}>
            {isLoading ? "Generating..." : intent === "create" ? "Generate" : "Run Update"}
          </button>
        </aside>

        <main className="images-result-panel">
          <section className="images-preview-area">
            {selectedSourceAsset ? (
              <div className="images-before-after">
                <div>
                  <span>Source</span>
                  {assetUrls[selectedSourceAsset.id] ? <img src={assetUrls[selectedSourceAsset.id]} alt="Source asset" /> : <div className="images-placeholder" />}
                </div>
                <div>
                  <span>Latest Result</span>
                  {currentAssets[0] && assetUrls[currentAssets[0].id] ? (
                    <img src={assetUrls[currentAssets[0].id]} alt="Generated result" />
                  ) : (
                    <div className="images-placeholder" />
                  )}
                </div>
              </div>
            ) : currentAssets.length > 0 ? (
              <div className="images-result-grid">
                {currentAssets.map((asset) => (
                  <article key={asset.id} className="images-result-card">
                    {assetUrls[asset.id] ? <img src={assetUrls[asset.id]} alt={asset.id} /> : <div className="images-placeholder" />}
                    <div>
                      <strong>{asset.width ?? "?"}x{asset.height ?? "?"}</strong>
                      <small>{formatBytes(asset.sizeBytes)}</small>
                    </div>
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
                ))}
              </div>
            ) : (
              <div className="images-empty-state">
                <h3>No image selected</h3>
                <p>Generate a new image, upload a reference, or choose a previous asset to refine.</p>
              </div>
            )}
          </section>

          {selectedJob ? (
            <section className="images-job-summary">
              <div>
                <strong>{intentLabels[selectedJob.intent]} / {selectedJob.status}</strong>
                <span>{selectedJob.provider} / {selectedJob.model}</span>
              </div>
              <p>{selectedJob.progress.message}</p>
              {selectedJob.errorMessage ? <p className="images-error">{selectedJob.errorMessage}</p> : null}
            </section>
          ) : null}
        </main>

        <aside className="images-history-panel">
          <div className="images-section-title">
            <strong>History</strong>
            <button type="button" onClick={() => void refreshHistory()}>Refresh</button>
          </div>
          <div className="images-history-list">
            {history.length === 0 ? (
              <p>No generations yet.</p>
            ) : history.map((job) => (
              <button
                key={job.jobId}
                type="button"
                className={selectedJob?.jobId === job.jobId ? "active" : ""}
                onClick={() => setSelectedJob(job)}
              >
                <strong>{job.prompt}</strong>
                <span>{intentLabels[job.intent]} / {job.status}</span>
                <small>{formatDateTime(job.updatedAt)}</small>
              </button>
            ))}
          </div>
        </aside>
      </section>
    </div>
  );
}
