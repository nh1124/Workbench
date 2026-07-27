import { useEffect, useState } from "react";
import { artifactsApi } from "../../lib/api";
import type { ArtifactEditorDraft } from "../types";
import { isImage, isPdf, isWordDocument } from "../utils/file";
import { itemToDraft } from "../utils/tree";

/**
 * Owns the object URLs behind the file preview pane.
 *
 * Three effects that all key off the open draft: fetching the PDF (either the
 * file itself or a rendered preview for Word documents), polling until a Word
 * preview finishes rendering, and fetching an image. Each revokes its object
 * URL on cleanup, which is why they belong together rather than scattered
 * through the page component.
 *
 * `setDraft` is needed because the poll refreshes the draft once the server
 * reports the preview is ready.
 */
export function useArtifactPreview(
  draft: ArtifactEditorDraft,
  setDraft: React.Dispatch<React.SetStateAction<ArtifactEditorDraft>>
) {
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [pdfExpanded, setPdfExpanded] = useState(false);

  useEffect(() => {
    const canShowPdfPreview =
      draft.id &&
      draft.kind === "file" &&
      (isPdf(draft) || (isWordDocument(draft) && draft.previewPdfStatus === "ready"));

    if (!canShowPdfPreview || !draft.id) {
      if (pdfBlobUrl) {
        URL.revokeObjectURL(pdfBlobUrl);
      }
      setPdfBlobUrl(null);
      setPdfExpanded(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const loadPromise = isPdf(draft)
      ? artifactsApi.downloadFile(draft.id, false)
      : artifactsApi.downloadPreviewPdf(draft.id);

    void loadPromise
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setPdfBlobUrl(null);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path, draft.previewPdfStatus]);

  useEffect(() => {
    if (!draft.id || draft.kind !== "file" || !isWordDocument(draft)) {
      return;
    }
    if (draft.previewPdfStatus === "ready" || draft.previewPdfStatus === "error") {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await artifactsApi.getItem(draft.id!);
        if (cancelled || next.id !== draft.id) return;
        setDraft((prev) => (prev.id === next.id ? itemToDraft(next) : prev));
      } catch {
        // Notification is handled globally.
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path, draft.previewPdfStatus]);

  useEffect(() => {
    if (!draft.id || draft.kind !== "file" || !isImage(draft)) {
      if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
      setImageBlobUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void artifactsApi
      .downloadFile(draft.id, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageBlobUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path]);

  return { pdfBlobUrl, imageBlobUrl, pdfExpanded, setPdfExpanded };
}
