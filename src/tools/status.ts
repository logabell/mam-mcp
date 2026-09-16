import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { errorContent, jsonContent } from "./respond.js";

export function registerStatusTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_client_status",
    {
      title: "Get torrent client status",
      description: "Check whether MouseSearch can reach your torrent client, and MouseSearch's client config.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ctx.mouseSearch.getStatus();
        return jsonContent({ httpStatus: result.status, ...(result.data as Record<string, unknown>) });
      } catch (error) {
        return errorContent(`get_client_status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "list_client_categories",
    {
      title: "List torrent client categories",
      description: "List categories available in your torrent client (useful values for cart_add's category field).",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ctx.mouseSearch.getCategories();
        return jsonContent({ httpStatus: result.status, categories: result.data });
      } catch (error) {
        return errorContent(`list_client_categories failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "get_download_status",
    {
      title: "Get download status",
      description:
        "Look up live torrent status for MIDs and/or torrent hashes. MIDs are resolved to hashes through " +
        "MouseSearch before polling. Returns a compact summary per torrent by default; pass verbose=true or a " +
        "`fields` list for more detail.",
      inputSchema: {
        mids: z.array(z.string()).optional(),
        hashes: z.array(z.string()).optional().describe("Torrent info hashes returned by cart_download"),
        verbose: z.boolean().optional().describe("Return the full qBittorrent object per torrent (default false)"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Subset of torrent fields to return (ignored when verbose=true)"),
      },
    },
    async (args) => {
      try {
        const resolvedMids: Record<string, { hash: string }> = {};
        const notFound: string[] = [];
        const hashes = new Set(args.hashes ?? []);
        for (const mid of args.mids ?? []) {
          const resolved = await ctx.mouseSearch.resolveMid(mid);
          if (resolved.found && resolved.hash) {
            resolvedMids[mid] = { hash: resolved.hash };
            hashes.add(resolved.hash);
          } else {
            notFound.push(mid);
          }
        }
        const torrents =
          hashes.size > 0 ? await ctx.mouseSearch.getTorrentInfoBatch([...hashes]) : ({} as Record<string, unknown>);

        const defaultFields = [
          "name",
          "state",
          "progress",
          "size",
          "downloaded",
          "amount_left",
          "eta",
          "dlspeed",
          "upspeed",
          "ratio",
          "category",
        ];
        const keys = args.fields && args.fields.length > 0 ? args.fields : defaultFields;
        const projected: Record<string, unknown> = {};
        for (const [hash, torrent] of Object.entries(torrents)) {
          if (args.verbose || torrent === null || typeof torrent !== "object") {
            projected[hash] = torrent;
            continue;
          }
          const record = torrent as Record<string, unknown>;
          projected[hash] = Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
        }

        return jsonContent({ resolvedMids, notFoundMids: notFound, torrents: projected });
      } catch (error) {
        return errorContent(`get_download_status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "check_library",
    {
      title: "Check whether torrents are already in your client",
      description:
        "For each MID, check whether it is already added to your torrent client (resolved via MouseSearch). " +
        "Useful to avoid duplicate downloads while building a cart.",
      inputSchema: { mids: z.array(z.string()) },
    },
    async (args) => {
      try {
        const results: Array<{ mid: string; downloaded: boolean; hash?: string }> = [];
        for (const mid of args.mids) {
          const resolved = await ctx.mouseSearch.resolveMid(mid);
          results.push({ mid, downloaded: resolved.found, hash: resolved.hash });
        }
        return jsonContent({ results });
      } catch (error) {
        return errorContent(`check_library failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
