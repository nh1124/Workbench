import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { navItems } from "../config/services";
import { clearWorkbenchSession, readWorkbenchSession } from "../lib/api";
import { useNotifications } from "../lib/notificationService";
import { QuickNoteModal } from "./QuickNoteModal";
import { ShortcutsModal } from "./ShortcutsModal";

const navIconMap: Record<string, ReactNode> = {
  Home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 10.5L12 3l9 7.5" />
      <path d="M5.5 9.5V21h13V9.5" />
    </svg>
  ),
  Project: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2.4" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  ),
  Tasks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
  ),
  Notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 3h8l4 4v14H7z" />
      <path d="M15 3v4h4M9 12h6M9 16h6" />
    </svg>
  ),
  Research: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15.2 15.2L21 21" />
      <path d="M8.5 10.5h4M10.5 8.5v4" />
    </svg>
  ),
  Artifacts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 7h6l2 2h10v11H3z" />
    </svg>
  )
};

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionUser = readWorkbenchSession();
  if (!sessionUser) {
    return <Navigate to="/login" replace />;
  }
  const username = sessionUser?.username ?? "guest";
  const shortName = username.length > 12 ? `${username.slice(0, 12)}...` : username;
  const userBadge = username.charAt(0).toUpperCase();
  const isTasksRoute = location.pathname.startsWith("/tasks");
  const isArtifactsRoute = location.pathname.startsWith("/artifacts");
  const isResearchRoute = location.pathname.startsWith("/research");
  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationMenuRef = useRef<HTMLDivElement>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isQuickNoteOpen, setIsQuickNoteOpen] = useState(false);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const {
    items: notifications,
    unreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications
  } = useNotifications();
  const isNativeRuntime = typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";

  useEffect(() => {
    setIsUserMenuOpen(false);
    setIsNotificationOpen(false);
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
      if (!notificationMenuRef.current?.contains(event.target as Node)) {
        setIsNotificationOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isQuickNoteShortcut = key === "n" && event.altKey && (event.metaKey || event.ctrlKey);
      if (isQuickNoteShortcut) {
        event.preventDefault();
        if (isNativeRuntime) {
          return;
        }
        const width = 560;
        const height = 760;
        const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
        const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2));
        const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`;
        const quickNoteWindow = window.open("/?quick-note-window=1", "workbench-quick-note", features);
        if (quickNoteWindow) {
          quickNoteWindow.focus();
        } else {
          setIsQuickNoteOpen(true);
        }
        setIsShortcutsOpen(false);
        setIsNotificationOpen(false);
        setIsUserMenuOpen(false);
        return;
      }

      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
        setIsShortcutsOpen(false);
        setIsQuickNoteOpen(false);
        setIsNotificationOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isNativeRuntime]);

  const logout = async () => {
    await clearWorkbenchSession();
    setIsUserMenuOpen(false);
    navigate("/login", { replace: true });
  };

  return (
    <div className={[
      "app-shell",
      isSidebarCollapsed ? "sidebar-collapsed" : "",
      isMobileMenuOpen ? "mobile-menu-open" : ""
    ].filter(Boolean).join(" ")}>
      {isMobileMenuOpen && (
        <div
          className="mobile-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}
      <aside className={isMobileMenuOpen ? "sidebar mobile-sidebar-open" : "sidebar"}>
        <div className="sidebar-top">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>

        <nav className="main-nav" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
              end={item.path === "/"}
            >
              <span className="nav-icon" aria-hidden="true">
                {navIconMap[item.label]}
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer-wrap" ref={userMenuRef}>
          {isUserMenuOpen ? (
            <div className="user-menu" role="menu" aria-label="User menu">
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setIsUserMenuOpen(false);
                  navigate("/settings");
                }}
              >
                <span className="user-menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M10.6 3.4h2.8l.5 2a6.7 6.7 0 0 1 1.6.9l1.9-.8 1.4 2.4-1.5 1.4c.1.5.2 1 .2 1.5s-.1 1-.2 1.5l1.5 1.4-1.4 2.4-1.9-.8c-.5.4-1 .7-1.6.9l-.5 2h-2.8l-.5-2a6.7 6.7 0 0 1-1.6-.9l-1.9.8-1.4-2.4 1.5-1.4a6 6 0 0 1 0-3l-1.5-1.4 1.4-2.4 1.9.8c.5-.4 1-.7 1.6-.9l.5-2z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                </span>
                <span className="user-menu-label">Settings</span>
              </button>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setIsUserMenuOpen(false);
                  setIsShortcutsOpen(true);
                }}
              >
                <span className="user-menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="3.5" y="6.5" width="17" height="11" rx="2" />
                    <path d="M7 10h1.5M10.5 10H12M14 10h1.5M17.5 10H19M7 13.5h5M13.5 13.5H19" />
                  </svg>
                </span>
                <span className="user-menu-label">Keyboard Shortcuts</span>
              </button>
              <button type="button" className="user-menu-item danger" role="menuitem" onClick={() => void logout()}>
                <span className="user-menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
                    <path d="M16 16l5-4-5-4" />
                    <path d="M21 12H9" />
                  </svg>
                </span>
                <span className="user-menu-label">Log out</span>
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className={isSidebarCollapsed ? "sidebar-footer collapsed" : "sidebar-footer"}
            aria-haspopup="menu"
            aria-expanded={isUserMenuOpen}
            onClick={() => setIsUserMenuOpen((prev) => !prev)}
          >
            <div className="user-badge">{userBadge}</div>
            <div>
              <strong>{shortName}</strong>
            </div>
            <span className="user-chevron" aria-hidden="true">
              ^
            </span>
          </button>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="mobile-hamburger"
              aria-label="Open navigation menu"
              onClick={() => setIsMobileMenuOpen((prev) => !prev)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <p className="topbar-brand">
              <span className="topbar-dot" aria-hidden="true" />
              WORKBENCH
            </p>
          </div>
          <div className="topbar-actions">
            <div className="notification-menu-wrap" ref={notificationMenuRef}>
              <button
                type="button"
                className={unreadCount > 0 ? "icon-button topbar-icon-button has-unread" : "icon-button topbar-icon-button"}
                aria-label="Notifications"
                aria-haspopup="menu"
                aria-expanded={isNotificationOpen}
                onClick={() => setIsNotificationOpen((prev) => !prev)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M12 4a4 4 0 0 0-4 4v2.5c0 .7-.2 1.3-.6 1.9L6 15h12l-1.4-2.6c-.4-.6-.6-1.2-.6-1.9V8a4 4 0 0 0-4-4z" />
                  <path d="M10 18a2 2 0 0 0 4 0" />
                </svg>
                {unreadCount > 0 ? (
                  <span className="notification-badge" aria-hidden="true">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </button>

              {isNotificationOpen ? (
                <div className="notification-menu" role="menu" aria-label="Notifications">
                  <div className="notification-menu-head">
                    <div className="notification-menu-head-left">
                      <div className="notification-menu-actions">
                        <button type="button" onClick={() => markAllNotificationsRead()}>Mark all read</button>
                        <button type="button" onClick={() => clearNotifications()}>Clear</button>
                      </div>
                      <strong>Notifications</strong>
                    </div>
                    <small>{unreadCount > 0 ? `${unreadCount} unread` : "All read"}</small>
                  </div>
                  <div className="notification-menu-list">
                    {notifications.length === 0 ? (
                      <p>No notifications yet.</p>
                    ) : (
                      notifications.map((notification) => (
                        <button
                          key={notification.id}
                          type="button"
                          className={[
                            "notification-item",
                            notification.read ? "read" : "",
                            `level-${notification.level}`
                          ].filter(Boolean).join(" ")}
                          onClick={() => markNotificationRead(notification.id)}
                        >
                          <div className="notification-item-top">
                            <strong>{notification.title}</strong>
                            <time>
                              {new Date(notification.createdAt).toLocaleTimeString("ja-JP", {
                                hour: "2-digit",
                                minute: "2-digit"
                              })}
                            </time>
                          </div>
                          <p>{notification.message}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="icon-button topbar-icon-button"
              aria-label="Settings"
              onClick={() => navigate("/settings")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M10.6 3.4h2.8l.5 2a6.7 6.7 0 0 1 1.6.9l1.9-.8 1.4 2.4-1.5 1.4c.1.5.2 1 .2 1.5s-.1 1-.2 1.5l1.5 1.4-1.4 2.4-1.9-.8c-.5.4-1 .7-1.6.9l-.5 2h-2.8l-.5-2a6.7 6.7 0 0 1-1.6-.9l-1.9.8-1.4-2.4 1.5-1.4a6 6 0 0 1 0-3l-1.5-1.4 1.4-2.4 1.9.8c.5-.4 1-.7 1.6-.9l.5-2z" />
                <circle cx="12" cy="12" r="2.6" />
              </svg>
            </button>
          </div>
        </header>
        <section
          className={
            isTasksRoute
              ? "page-frame tasks-page-frame"
              : isArtifactsRoute
                ? "page-frame artifacts-page-frame"
                : isResearchRoute
                  ? "page-frame research-page-frame"
                  : "page-frame"
          }
        >
          <Outlet />
        </section>
      </main>

      <ShortcutsModal open={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
      <QuickNoteModal open={isQuickNoteOpen} onClose={() => setIsQuickNoteOpen(false)} />
    </div>
  );
}
