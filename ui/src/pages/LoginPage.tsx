import { useState, useEffect, useRef, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { getWorkbenchCoreUrlInitialValue, setWorkbenchCoreUrl } from "../config/services";
import { coreApi, readWorkbenchSession, saveWorkbenchSession } from "../lib/api";
import "./LoginPage.css";

const LOGIN_HISTORY_KEY = "workbench-login-history";

interface LoginEntry {
  serverUrl: string;
  username: string;
  password: string;
}

function readLoginHistory(): LoginEntry[] {
  try {
    const raw = window.localStorage.getItem(LOGIN_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLoginHistory(history: LoginEntry[]): void {
  try {
    window.localStorage.setItem(LOGIN_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore storage errors
  }
}

function upsertLoginEntry(history: LoginEntry[], entry: LoginEntry): LoginEntry[] {
  const filtered = history.filter((h) => h.serverUrl !== entry.serverUrl);
  return [entry, ...filtered].slice(0, 10);
}

export function LoginPage() {
  const navigate = useNavigate();
  const currentSession = readWorkbenchSession();

  const [serverUrl, setServerUrl] = useState(() => getWorkbenchCoreUrlInitialValue());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loginHistory] = useState<LoginEntry[]>(() => readLoginHistory());
  const [showUrlDropdown, setShowUrlDropdown] = useState(false);

  const comboboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setShowUrlDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (currentSession) {
    return <Navigate to="/" replace />;
  }

  const handleSelectEntry = (entry: LoginEntry) => {
    setServerUrl(entry.serverUrl);
    setUsername(entry.username);
    setPassword(entry.password);
    setShowUrlDropdown(false);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!serverUrl.trim() || !username.trim() || !password) {
      setError("Server URL, username and password are required.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const normalizedServerUrl = setWorkbenchCoreUrl(serverUrl);
      setServerUrl(normalizedServerUrl);

      const response = await coreApi.login(username, password);
      await saveWorkbenchSession(response);

      const newHistory = upsertLoginEntry(readLoginHistory(), {
        serverUrl: normalizedServerUrl,
        username,
        password,
      });
      saveLoginHistory(newHistory);

      navigate("/", { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card login-card">
        <div className="login-brand">
          <div className="login-brand-icon" aria-hidden="true">
            <span>WB</span>
          </div>
          <p className="auth-eyebrow">WORKBENCH</p>
        </div>

        <form className="auth-form" onSubmit={onSubmit}>
          <label className="auth-field">
            <span className="auth-field-label">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="Enter username"
            />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Enter password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <details className="auth-advanced">
            <summary>Advanced</summary>
            <div className="auth-advanced-content">
              <div className="auth-field">
                <span className="auth-field-label">Server URL</span>
                <div className="url-combobox" ref={comboboxRef}>
                  <div className="url-combobox-input-row">
                    <input
                      type="url"
                      value={serverUrl}
                      onChange={(event) => setServerUrl(event.target.value)}
                      onFocus={() => loginHistory.length > 0 && setShowUrlDropdown(true)}
                      autoComplete="off"
                      placeholder="http://localhost:3000"
                    />
                    {loginHistory.length > 0 && (
                      <button
                        type="button"
                        className="url-combobox-chevron"
                        onClick={() => setShowUrlDropdown((v) => !v)}
                        aria-label="Show previous server URLs"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          style={{ transform: showUrlDropdown ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                        >
                          <path
                            d="M2 4L6 8L10 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                  {showUrlDropdown && loginHistory.length > 0 && (
                    <ul className="url-combobox-dropdown" role="listbox">
                      {loginHistory.map((entry) => (
                        <li key={entry.serverUrl} role="option">
                          <button
                            type="button"
                            className="url-combobox-option"
                            onClick={() => handleSelectEntry(entry)}
                          >
                            <span className="url-combobox-option-url">{entry.serverUrl}</span>
                            <span className="url-combobox-option-user">{entry.username}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </details>
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="auth-footer">
          No account yet? <Link to="/register">Create one</Link>
        </p>
      </section>
    </main>
  );
}
