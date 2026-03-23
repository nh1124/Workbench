import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { issueTokenBundle } from "../auth.js";
import { loginUser } from "../store.js";
import { asMcpText } from "./helpers.js";

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "workbench.login",
    {
      title: "Login to Workbench",
      description:
        "Authenticate with Workbench using username and password. Returns an accessToken to use in all subsequent tool calls.",
      inputSchema: {
        username: z.string().min(1).describe("Workbench username"),
        password: z.string().min(1).describe("Workbench password")
      }
    },
    async ({ username, password }) => {
      const user = await loginUser(username, password);
      if (!user) {
        throw new Error("Invalid username or password");
      }
      const bundle = issueTokenBundle({ userId: user.id, username: user.username });
      return asMcpText({
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        tokenType: bundle.tokenType,
        expiresInSeconds: bundle.expiresInSeconds,
        username: user.username
      });
    }
  );
}
