import { Navigate, Outlet, useLocation } from "react-router-dom";
import { readWorkbenchSession } from "../lib/api";

/**
 * Layout for the dedicated native apps (Workbench Tasks / Notes / Artifacts).
 *
 * These launch straight into one feature, so the shell deliberately drops everything
 * that exists to move between features: the primary sidebar and the workspace topbar
 * (brand, sync status, notifications, settings). The page gets the whole window.
 *
 * The main app keeps using {@link Layout}; this component is intentionally separate so
 * refinements here can be reviewed on their own before any of it is taken back to main.
 */

const PAGE_FRAME_MODIFIERS: Array<{ prefix: string; className: string }> = [
  { prefix: "/tasks", className: "tasks-page-frame" },
  { prefix: "/artifacts", className: "artifacts-page-frame" },
  { prefix: "/research", className: "research-page-frame" },
  { prefix: "/images", className: "images-page-frame" },
  { prefix: "/mindmaps", className: "mindmaps-page-frame" },
  { prefix: "/wbs", className: "wbs-page-frame" }
];

export function pageFrameClassName(pathname: string): string {
  const modifier = PAGE_FRAME_MODIFIERS.find((entry) => pathname.startsWith(entry.prefix));
  return modifier ? `page-frame ${modifier.className}` : "page-frame";
}

export function VariantShell() {
  const location = useLocation();
  const sessionUser = readWorkbenchSession();
  if (!sessionUser) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="variant-shell">
      <section className={pageFrameClassName(location.pathname)}>
        <Outlet />
      </section>
    </div>
  );
}
