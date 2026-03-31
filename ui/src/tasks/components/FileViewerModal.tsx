import type { FileViewerState } from "../hooks/useTaskMutations";
import { IcoDownload, IcoFile, IcoX } from "./icons";

export interface FileViewerModalProps {
  fileViewer: FileViewerState | null;
  onClose: () => void;
}

export function FileViewerModal({ fileViewer, onClose }: FileViewerModalProps) {
  if (!fileViewer) return null;

  return (
    <div className="file-viewer-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="file-viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-viewer-header">
          <span className="file-viewer-name">
            <IcoFile /> {fileViewer.filename}
          </span>
          <div className="file-viewer-header-actions">
            <button
              type="button"
              className="file-viewer-action"
              title="Download"
              onClick={() => {
                const a = document.createElement("a");
                a.href = fileViewer.objectUrl;
                a.download = fileViewer.filename;
                a.click();
              }}
            >
              <IcoDownload />
            </button>
            <button type="button" className="file-viewer-close" onClick={onClose}>
              <IcoX />
            </button>
          </div>
        </div>
        <div className="file-viewer-body">
          {fileViewer.mimeType.startsWith("image/") ? (
            <img src={fileViewer.objectUrl} alt={fileViewer.filename} className="file-viewer-img" />
          ) : fileViewer.mimeType === "application/pdf" || fileViewer.mimeType.startsWith("text/") ? (
            <iframe
              src={fileViewer.objectUrl}
              title={fileViewer.filename}
              className={`file-viewer-iframe${fileViewer.mimeType.startsWith("text/") ? " file-viewer-text" : ""}`}
            />
          ) : (
            <div className="file-viewer-unsupported">
              <IcoFile />
              <p>{fileViewer.filename}</p>
              <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                Preview not available for this file type.
              </p>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = fileViewer.objectUrl;
                  a.download = fileViewer.filename;
                  a.click();
                }}
              >
                <IcoDownload /> Download
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
