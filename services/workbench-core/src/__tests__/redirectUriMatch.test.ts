import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redirectUriMatches } from "../httpServer.js";

describe("redirectUriMatches (RFC 8252 loopback port relaxation)", () => {
  it("matches an exact non-loopback URI", () => {
    assert.equal(redirectUriMatches("https://app.example/cb", "https://app.example/cb"), true);
  });

  it("rejects a non-loopback URI whose port differs", () => {
    assert.equal(redirectUriMatches("https://app.example/cb", "https://app.example:8443/cb"), false);
  });

  it("allows any ephemeral port for a registered loopback URI (Claude Code case)", () => {
    // Registered document has no fixed port; the native client binds a random one.
    assert.equal(redirectUriMatches("http://localhost/callback", "http://localhost:45675/callback"), true);
    assert.equal(redirectUriMatches("http://localhost:1/callback", "http://localhost:60000/callback"), true);
  });

  it("treats loopback hostnames as equivalent", () => {
    assert.equal(redirectUriMatches("http://127.0.0.1/callback", "http://localhost:45675/callback"), true);
    assert.equal(redirectUriMatches("http://localhost/callback", "http://127.0.0.1:8080/callback"), true);
    assert.equal(redirectUriMatches("http://[::1]/callback", "http://localhost:5000/callback"), true);
  });

  it("still requires the path to match for loopback URIs", () => {
    assert.equal(redirectUriMatches("http://localhost/callback", "http://localhost:45675/other"), false);
  });

  it("still requires the query string to match for loopback URIs", () => {
    assert.equal(redirectUriMatches("http://localhost/cb", "http://localhost:45675/cb?x=1"), false);
  });

  it("does not relax https loopback (only http loopback is a native redirect)", () => {
    assert.equal(redirectUriMatches("https://localhost/callback", "https://localhost:45675/callback"), false);
  });
});
