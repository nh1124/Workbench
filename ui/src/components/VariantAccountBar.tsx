import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getWorkbenchCoreUrl } from "../config/services";
import { clearWorkbenchSession, readWorkbenchSession } from "../lib/api";

/**
 * Account row for the dedicated apps, sitting where the feature's own tool name used to be.
 *
 * A dedicated app has no sidebar and no topbar, so this is the only place to see who you
 * are signed in as, which server you are pointed at, and to sign out or switch servers.
 * Signing out lands on the sign-in page, which is also where the server URL is set.
 */

/** Shows the host only — the scheme and path are noise at this size. */
export function serverLabel(coreUrl: string): string {
  try {
    return new URL(coreUrl).host;
  } catch {
    return coreUrl;
  }
}

export function VariantAccountBar() {
  const navigate = useNavigate();
  const session = readWorkbenchSession();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMenuOpen]);

  const username = session?.username ?? "Not signed in";
  const initial = (session?.username ?? "?").charAt(0).toUpperCase();

  const signOut = async () => {
    await clearWorkbenchSession();
    setIsMenuOpen(false);
    navigate("/login", { replace: true });
  };

  return (
    <div className="variant-account-bar" ref={menuRef}>
      <button
        type="button"
        className="variant-account-trigger"
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label={`Account: ${username}`}
        title={`${username} — ${serverLabel(getWorkbenchCoreUrl())}`}
        onClick={() => setIsMenuOpen((open) => !open)}
      >
        <span className="variant-account-avatar" aria-hidden="true">{initial}</span>
      </button>

      {isMenuOpen ? (
        <div className="variant-account-menu" role="menu">
          {/* The trigger is avatar-only in the title bar, so the identity lives here. */}
          <div className="variant-account-identity">
            <span className="variant-account-name">{username}</span>
            <span className="variant-account-server">{serverLabel(getWorkbenchCoreUrl())}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              navigate("/settings");
            }}
          >
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              navigate("/login");
            }}
          >
            {session ? "Switch server or account" : "Sign in"}
          </button>
          {session ? (
            <button type="button" role="menuitem" className="danger" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
