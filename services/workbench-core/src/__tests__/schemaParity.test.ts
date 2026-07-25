import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { imageGenerationFields, imageGenerationRequestSchema } from "../schemas/images.js";
import {
  mindmapArtifactSaveFields,
  mindmapArtifactSaveSchema,
  mindmapCreateFields,
  mindmapCreateSchema,
  mindmapUpdateFields,
  mindmapUpdateSchema
} from "../schemas/mindmaps.js";
import {
  wbsItemCreateFields,
  wbsItemCreateSchema,
  wbsItemUpdateFields,
  wbsItemUpdateSchema,
  wbsPlanCreateFields,
  wbsPlanCreateSchema,
  wbsPlanUpdateFields,
  wbsPlanUpdateSchema
} from "../schemas/wbs.js";

function objectKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

function shapeKeys(shape: Record<string, unknown>): string[] {
  return Object.keys(shape).sort();
}

/**
 * The HTTP facade and the MCP tools validate the same domains. They used to hold
 * separate copies and drifted silently: the MCP image surface was missing
 * `sourceArtifactItemIds`, and MCP accepted empty WBS titles that HTTP rejected.
 * Both now build from one shape, and these assertions keep the two views aligned.
 */
describe("HTTP/MCP schema parity", () => {
  it("derives the HTTP image request from the shared MCP fields plus intent", () => {
    assert.deepEqual(
      objectKeys(imageGenerationRequestSchema),
      [...shapeKeys(imageGenerationFields), "intent"].sort()
    );
  });

  it("keeps the image contract carrying artifact sources on both surfaces", () => {
    assert.ok(
      "sourceArtifactItemIds" in imageGenerationFields,
      "sourceArtifactItemIds must stay in the shared fields so MCP keeps parity with HTTP"
    );
  });

  it("derives mindmap HTTP objects from the shared fields", () => {
    assert.deepEqual(objectKeys(mindmapCreateSchema), shapeKeys(mindmapCreateFields));
    assert.deepEqual(objectKeys(mindmapUpdateSchema), shapeKeys(mindmapUpdateFields));
    assert.deepEqual(objectKeys(mindmapArtifactSaveSchema), shapeKeys(mindmapArtifactSaveFields));
  });

  it("derives WBS HTTP objects from the shared fields", () => {
    assert.deepEqual(objectKeys(wbsPlanCreateSchema), shapeKeys(wbsPlanCreateFields));
    assert.deepEqual(objectKeys(wbsPlanUpdateSchema), shapeKeys(wbsPlanUpdateFields));
    assert.deepEqual(objectKeys(wbsItemCreateSchema), shapeKeys(wbsItemCreateFields));
    assert.deepEqual(objectKeys(wbsItemUpdateSchema), shapeKeys(wbsItemUpdateFields));
  });

  it("rejects empty WBS titles on the shared contract", () => {
    assert.equal(wbsPlanCreateSchema.safeParse({ title: "" }).success, false);
    assert.equal(wbsPlanUpdateSchema.safeParse({ expectedVersion: 1, title: "" }).success, false);
    assert.equal(wbsItemCreateSchema.safeParse({ title: "" }).success, false);
    assert.equal(wbsItemUpdateSchema.safeParse({ expectedVersion: 1, title: "" }).success, false);
  });
});
