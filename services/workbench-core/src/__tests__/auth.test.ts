import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";

const { isOAuthScopedToken, issueTokenBundle, verifyAccessToken } = await import("../auth.js");

// Core's OAuth authorization-code flow (issueUserOAuthAccessToken in httpServer.ts) signs
// access tokens with the SAME secret/issuer as the password-login flow, adding only a
// `scope` claim (e.g. "mcp:tools"). Since jwt.verify by itself does not distinguish them,
// user-only write routes (proposal approve/reject, collection/automation settings, routine
// schedules) must reject tokens carrying that claim. These tests pin down the distinguishing
// signal `isOAuthScopedToken` relies on.
describe("OAuth-scoped token detection", () => {
  it("treats a password-login token (no scope claim) as not OAuth-scoped", () => {
    const bundle = issueTokenBundle({ userId: "user-1", username: "alice" });
    const claims = verifyAccessToken(bundle.accessToken);
    assert.equal(isOAuthScopedToken(claims), false);
  });

  it("treats a token carrying a scope claim as OAuth-scoped, even with a narrow scope", () => {
    const token = jwt.sign(
      { sub: "user-1", username: "alice", tokenUse: "access", scope: "mcp:tools" },
      process.env.JWT_SECRET as string,
      { algorithm: "HS256", issuer: process.env.JWT_ISSUER, expiresIn: 3600 }
    );
    const claims = verifyAccessToken(token);
    assert.equal(isOAuthScopedToken(claims), true);
    assert.equal(claims.scope, "mcp:tools");
  });
});
