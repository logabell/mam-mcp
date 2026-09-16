import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import type { MamUserData } from "../mousesearch/client.js";
import { computeBufferGb, isVipActive } from "../mousesearch/client.js";
import { errorContent, jsonContent } from "./respond.js";

export function registerAccountTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_account_stats",
    {
      title: "Get MyAnonamouse account stats",
      description:
        "Fetch your MAM ratio, upload/download totals, buffer, seed bonus, and VIP status via MouseSearch. " +
        "Use this before bulk downloads to avoid buffer exhaustion.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ctx.mouseSearch.getUserData();
        if (!result.ok) {
          const data = result.data as Partial<MamUserData> | null;
          const message =
            (data && typeof data.error === "string" && data.error) ||
            `MouseSearch returned HTTP ${result.status} for /mam/user_data`;
          return errorContent(message);
        }
        const data = result.data;
        return jsonContent({
          username: data.username,
          seedbonus: data.seedbonus,
          uploaded: data.uploaded,
          downloaded: data.downloaded,
          ratio: data.ratio,
          buffer_gb: computeBufferGb(data),
          vip_active: isVipActive(data),
          vip_until: data.vip_until,
        });
      } catch (error) {
        return errorContent(`get_account_stats failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
