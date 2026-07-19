import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectionSettingsSchema,
  DEFAULT_COLLECTION_SETTINGS
} from "../types.js";

describe("analyser collection settings", () => {
  it("provides privacy-preserving owner defaults", () => {
    assert.equal(DEFAULT_COLLECTION_SETTINGS.workbenchChanges, "metadata");
    assert.equal(DEFAULT_COLLECTION_SETTINGS.mcpAccess, "mutations");
    assert.equal(DEFAULT_COLLECTION_SETTINGS.uiAccess, "mutations");
    assert.equal(DEFAULT_COLLECTION_SETTINGS.agentSessionEvents, "explicit_only");
    assert.equal(DEFAULT_COLLECTION_SETTINGS.foregroundAppCapture, false);
    assert.equal(DEFAULT_COLLECTION_SETTINGS.foregroundAppUpload, false);
    assert.equal(DEFAULT_COLLECTION_SETTINGS.windowTitleCapture, false);
    assert.equal(DEFAULT_COLLECTION_SETTINGS.windowTitleUpload, false);
    assert.equal(DEFAULT_COLLECTION_SETTINGS.localFileEvents, "off");
    assert.equal(DEFAULT_COLLECTION_SETTINGS.localFileUpload, false);
    assert.equal(DEFAULT_COLLECTION_SETTINGS.screenshots, "off");
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.retentionDays, {
      workbench_change: 30,
      mcp_access: 30,
      ui_access: 30,
      agent_session: 30,
      pc_activity: 30,
      local_file: 30
    });
    assert.equal(DEFAULT_COLLECTION_SETTINGS.localScreenshotRetentionDays, 7);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.projectAllow, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.projectDeny, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.resourceTypeAllow, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.resourceTypeDeny, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.localRootAllow, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.localRootDeny, []);
    assert.deepEqual(DEFAULT_COLLECTION_SETTINGS.excludePatterns, []);
  });

  it("rejects unknown fields", () => {
    assert.equal(collectionSettingsSchema.safeParse({ unexpected: true }).success, false);
    assert.equal(collectionSettingsSchema.safeParse({ retentionDays: { unknown_source: 30 } }).success, false);
  });

  it("rejects out-of-range retention days", () => {
    assert.equal(collectionSettingsSchema.safeParse({ retentionDays: { workbench_change: 0 } }).success, false);
    assert.equal(collectionSettingsSchema.safeParse({ retentionDays: { mcp_access: 91 } }).success, false);
    assert.equal(collectionSettingsSchema.safeParse({ localScreenshotRetentionDays: 0 }).success, false);
    assert.equal(collectionSettingsSchema.safeParse({ localScreenshotRetentionDays: 31 }).success, false);
  });
});
