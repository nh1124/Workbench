import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { getWorkbenchCoreUrlInitialValue, setWorkbenchCoreUrl } from "../config/services";
import { coreApi, readWorkbenchSession, saveWorkbenchSession } from "../lib/api";
import "./LoginPage.css";

export function RegisterPage() {
  const navigate = useNavigate();
  const currentSession = readWorkbenchSession();
  const [serverUrl, setServerUrl] = useState(() => getWorkbenchCoreUrlInitialValue());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (currentSession) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!serverUrl.trim() || !username.trim() || !password || !confirmPassword) {
      setError("Server URL, username and password are required.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Password and confirmation do not match.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const normalizedServerUrl = setWorkbenchCoreUrl(serverUrl);
      setServerUrl(normalizedServerUrl);

      const response = await coreApi.register(username, password);
      await saveWorkbenchSession(response);
      navigate("/", { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Registration failed.");
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
              autoComplete="new-password"
              placeholder="Create password"
            />
          </label>
          <label className="auth-field">
            <span className="auth-field-label">Confirm Password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <details className="auth-advanced">
            <summary>Advanced</summary>
            <div className="auth-advanced-content">
              <label className="auth-field">
                <span className="auth-field-label">Server URL</span>
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  autoComplete="off"
                  placeholder="http://localhost:3000"
                />
              </label>
            </div>
          </details>
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create Account"}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
