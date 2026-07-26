import { normalizeScope } from "./tokens.js";

export type AuthorizeRequestParams = {
  responseType: "code";
  clientId: string;
  redirectUri: string;
  state?: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export function readAuthorizeParams(source: Record<string, unknown>): AuthorizeRequestParams | { error: string } {
  const responseType = typeof source.response_type === "string" ? source.response_type.trim() : "";
  if (responseType !== "code") {
    return { error: "unsupported_response_type" };
  }

  const clientId = typeof source.client_id === "string" ? source.client_id.trim() : "";
  if (!clientId) {
    return { error: "invalid_client" };
  }

  const redirectUri = typeof source.redirect_uri === "string" ? source.redirect_uri.trim() : "";
  if (!redirectUri) {
    return { error: "invalid_redirect_uri" };
  }

  const resource = typeof source.resource === "string" ? source.resource.trim() : "";
  if (!resource) {
    return { error: "invalid_request" };
  }

  const normalizedScope = normalizeScope(typeof source.scope === "string" ? source.scope : undefined);
  if (!normalizedScope) {
    return { error: "invalid_scope" };
  }

  const codeChallenge = typeof source.code_challenge === "string" ? source.code_challenge.trim() : "";
  if (!codeChallenge) {
    return { error: "invalid_request" };
  }

  const codeChallengeMethodRaw =
    typeof source.code_challenge_method === "string" ? source.code_challenge_method.trim() : "";
  if (codeChallengeMethodRaw !== "S256") {
    return { error: "invalid_request" };
  }

  const state = typeof source.state === "string" && source.state.trim().length > 0 ? source.state : undefined;
  return {
    responseType: "code",
    clientId,
    redirectUri,
    state,
    resource,
    scope: normalizedScope,
    codeChallenge,
    codeChallengeMethod: "S256"
  };
}

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderAuthorizeLoginForm(params: AuthorizeRequestParams, errorMessage?: string): string {
  const errorHtml = errorMessage
    ? `<p style="color:#b91c1c;background:#fee2e2;padding:8px 10px;border-radius:6px;">${escapeHtml(errorMessage)}</p>`
    : "";
  const stateInput = params.state
    ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}" />`
    : "";
  const resourceInput = `<input type="hidden" name="resource" value="${escapeHtml(params.resource)}" />`;
  const scopeInput = `<input type="hidden" name="scope" value="${escapeHtml(params.scope)}" />`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workbench Authorization</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f8fafc; margin:0; }
      main { max-width:420px; margin:56px auto; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:24px; }
      h1 { margin:0 0 10px; font-size:20px; }
      p { margin:0 0 16px; color:#334155; font-size:14px; }
      label { display:block; margin:12px 0 6px; font-size:13px; color:#0f172a; }
      input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; }
      button { margin-top:16px; width:100%; border:0; border-radius:8px; padding:11px 12px; background:#0f172a; color:#fff; font-weight:600; cursor:pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize Workbench Access</h1>
      <p>Sign in to continue with Claude connector authorization.</p>
      ${errorHtml}
      <form method="post" action="/authorize">
        <input type="hidden" name="response_type" value="${params.responseType}" />
        <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
        <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="${params.codeChallengeMethod}" />
        ${stateInput}
        ${resourceInput}
        ${scopeInput}
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit">Authorize</button>
      </form>
    </main>
  </body>
</html>`;
}
