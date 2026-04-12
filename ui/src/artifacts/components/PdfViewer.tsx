import { useEffect, useRef, useState } from "react";
import { IcoComment, IcoCompress, IcoExpand } from "./ArtifactsIcons";
import { PdfPageComments } from "./PdfPageComments";
import "./PdfViewer.css";

interface PdfViewerProps {
  blobUrl: string;
  title: string;
  artifactId: string;
  expanded: boolean;
  onToggleExpand: () => void;
}

function readPageFromIframe(iframe: HTMLIFrameElement): number | null {
  try {
    const hash = iframe.contentWindow?.location.hash ?? "";
    const match = /[#&]page=(\d+)/i.exec(hash);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

export function PdfViewer({ blobUrl, title, artifactId, expanded, onToggleExpand }: PdfViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDetected, setPageDetected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Poll iframe hash to detect current page (Chrome/Edge only)
  useEffect(() => {
    let lastHash = "";
    const poll = () => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      try {
        const hash = iframe.contentWindow?.location.hash ?? "";
        if (hash === lastHash) return;
        lastHash = hash;
        const page = readPageFromIframe(iframe);
        if (page !== null) {
          setCurrentPage(page);
          setPageDetected(true);
        }
      } catch {
        // sandboxed or not yet loaded — ignore
      }
    };
    const id = setInterval(poll, 600);
    return () => clearInterval(id);
  }, [blobUrl]);

  // Reset on artifact change
  useEffect(() => {
    setCurrentPage(1);
    setPageDetected(false);
  }, [artifactId]);

  return (
    <div className="pdf-viewer">
      {/* Toolbar */}
      <div className="pdf-viewer-toolbar">
        <span className="pdf-viewer-label">{expanded ? title : "Preview"}</span>
        <div className="pdf-viewer-toolbar-right">
          <button
            type="button"
            className={`va-icon-btn${sidebarOpen ? " active" : ""}`}
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Hide comments" : "Show comments"}
            aria-label={sidebarOpen ? "Hide comments" : "Show comments"}
          >
            <IcoComment />
          </button>
          <button
            type="button"
            className="va-icon-btn va-expand-btn"
            onClick={onToggleExpand}
            title={expanded ? "Collapse (Ctrl+Shift+↓)" : "Expand (Ctrl+Shift+↑)"}
            aria-label={expanded ? "Collapse PDF viewer" : "Expand PDF viewer"}
          >
            {expanded ? <IcoCompress /> : <IcoExpand />}
          </button>
        </div>
      </div>

      {/* Body: iframe + optional sidebar */}
      <div className="pdf-viewer-body">
        <iframe ref={iframeRef} src={blobUrl} className="va-pdf-frame" title={title} />
        {sidebarOpen && (
          <PdfPageComments
            artifactId={artifactId}
            currentPage={currentPage}
            pageDetected={pageDetected}
            onPageChange={setCurrentPage}
          />
        )}
      </div>
    </div>
  );
}
