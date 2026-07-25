import { z } from "zod";

/**
 * Deep Research value schemas shared by the HTTP facade and the MCP tools.
 *
 * Unlike images/mindmaps/wbs, the field *names* legitimately differ between the
 * two surfaces: MCP tools expose snake_case by convention while the HTTP API is
 * camelCase. Only the value domains are genuinely duplicated, so only those are
 * shared here — forcing a common shape would mean a case-mapping layer that
 * buys nothing.
 */

export const deepResearchProviderSchema = z.enum(["auto", "gemini", "openai", "anthropic"]);
export const deepResearchSpeedSchema = z.enum(["deep", "fast"]);
