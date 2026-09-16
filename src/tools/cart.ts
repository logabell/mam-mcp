import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import type { CartItem } from "../cart/store.js";
import { appendPersonalFreeleechFlag } from "../mam/search.js";
import { isParseableSize } from "../util/size.js";
import { errorContent, jsonContent } from "./respond.js";

const torrentSchema = z.object({
  mid: z.string().describe("MAM torrent id (MID)"),
  title: z.string(),
  author: z.string().default("").describe("Author display name; use 'Unknown' if missing"),
  size: z.string().default("").describe('Human size like "1.5 GiB" (from search_mam)'),
  mainCat: z.string().default("").describe("MAM main category id (13/14/15/16)"),
  catname: z.string().default("").describe('MAM catname like "Audiobooks - Science Fiction"'),
  filetype: z.string().default(""),
  seriesRaw: z.string().default("").describe("Raw series_info JSON string from search_mam"),
  downloadLink: z.string().describe("Download URL from search_mam (contains the tid parameter)"),
  free: z.boolean().default(false),
  vipFreeleech: z.boolean().default(false),
  personalFreeleech: z.boolean().default(false),
});

export function registerCartTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "cart_add",
    {
      title: "Add torrent to download cart",
      description:
        "Add a search result to the persistent download cart. This does not download anything; call cart_download to commit.",
      inputSchema: {
        torrent: torrentSchema,
        category: z.string().optional().describe("Torrent-client category override (e.g. 'audiobooks')"),
        customRelativePath: z.string().optional().describe("Organization path override (only if auto-organize is on)"),
        customDestinationPath: z.string().optional().describe("Organization destination override"),
        usePersonalFreeleech: z.boolean().optional().describe("Request spending a personal freeleech wedge"),
        note: z.string().optional(),
      },
    },
    async (args) => {
      const torrent = args.torrent;
      const item: CartItem = {
        mid: String(torrent.mid),
        title: torrent.title,
        author: torrent.author || "Unknown",
        size: torrent.size,
        mainCat: torrent.mainCat,
        catname: torrent.catname,
        filetype: torrent.filetype,
        seriesInfo: torrent.seriesRaw,
        downloadLink: torrent.downloadLink,
        free: torrent.free,
        vipFreeleech: torrent.vipFreeleech,
        personalFreeleech: torrent.personalFreeleech,
        usePersonalFreeleech: args.usePersonalFreeleech ?? false,
        category: args.category,
        customRelativePath: args.customRelativePath,
        customDestinationPath: args.customDestinationPath,
        note: args.note,
        addedAt: new Date().toISOString(),
      };
      const outcome = ctx.cart.add(item);
      return jsonContent({ outcome, mid: item.mid, cartSize: ctx.cart.list().length });
    },
  );

  server.registerTool(
    "cart_list",
    {
      title: "List download cart",
      description: "List the torrents currently queued in the download cart.",
      inputSchema: {},
    },
    async () => jsonContent({ count: ctx.cart.list().length, items: ctx.cart.list() }),
  );

  server.registerTool(
    "cart_remove",
    {
      title: "Remove torrent from cart",
      description: "Remove a single torrent from the cart by MID.",
      inputSchema: { mid: z.string() },
    },
    async (args) => {
      const removed = ctx.cart.remove(args.mid);
      return jsonContent({ removed, mid: args.mid, cartSize: ctx.cart.list().length });
    },
  );

  server.registerTool(
    "cart_clear",
    {
      title: "Clear download cart",
      description: "Remove all torrents from the cart.",
      inputSchema: {},
    },
    async () => jsonContent({ cleared: ctx.cart.clear() }),
  );

  server.registerTool(
    "cart_download",
    {
      title: "Download cart via MouseSearch",
      description:
        "Send every cart item to MouseSearch's /client/add endpoint. MouseSearch performs its own buffer " +
        "checks, freeleech handling, category assignment, path templating, and auto-organization. Nothing is " +
        "added when the account buffer is insufficient. Successful items are removed from the cart by default; " +
        "failures remain so they can be retried or removed.",
      inputSchema: {
        mids: z.array(z.string()).optional().describe("Optional subset of MIDs to download; defaults to the whole cart"),
        removeOnSuccess: z.boolean().optional().describe("Remove successfully added items from the cart (default true)"),
      },
    },
    async (args) => {
      const all = ctx.cart.list();
      const wanted = args.mids && args.mids.length > 0 ? new Set(args.mids) : null;
      const items = wanted ? all.filter((item) => wanted.has(item.mid)) : all;

      if (items.length === 0) {
        return jsonContent({ requested: 0, added: 0, failed: 0, results: [] });
      }

      const removeOnSuccess = args.removeOnSuccess ?? true;
      const results: Array<Record<string, unknown>> = [];
      let added = 0;
      let failed = 0;

      for (const item of items) {
        if (!item.downloadLink) {
          failed += 1;
          results.push({ mid: item.mid, title: item.title, status: "error", error: "Missing downloadLink" });
          continue;
        }
        if (!isParseableSize(item.size)) {
          failed += 1;
          results.push({
            mid: item.mid,
            title: item.title,
            status: "error",
            error: `Unparseable size "${item.size}" — refusing to bypass MouseSearch buffer checks. Re-fetch via search_mam.`,
          });
          continue;
        }

        const torrentUrl = item.personalFreeleech
          ? appendPersonalFreeleechFlag(item.downloadLink)
          : item.downloadLink;

        const payload: Record<string, unknown> = {
          torrent_url: torrentUrl,
          id: item.mid,
          author: item.author || "Unknown",
          title: item.title || "Unknown",
          size: item.size,
          main_cat: item.mainCat,
          catname: item.catname,
          filetype: item.filetype,
          series_info: item.seriesInfo,
          free: item.free ? 1 : 0,
          vip_freeleech: item.vipFreeleech ? 1 : 0,
          personal_freeleech: item.personalFreeleech ? 1 : 0,
          use_personal_freeleech: item.usePersonalFreeleech === true,
        };
        const category = item.category ?? ctx.config.defaultCategory;
        if (category) payload.category = category;
        if (item.customRelativePath) payload.custom_relative_path = item.customRelativePath;
        if (item.customDestinationPath) payload.custom_destination_path = item.customDestinationPath;

        try {
          const response = await ctx.mouseSearch.addTorrent(payload);
          const body = response.data;
          if (body.status === "insufficient_buffer") {
            failed += 1;
            results.push({
              mid: item.mid,
              title: item.title,
              status: "insufficient_buffer",
              buffer_gb: body.buffer_gb,
              torrent_size_gb: body.torrent_size_gb,
              needed_gb: body.needed_gb,
              recommended_amount: body.recommended_amount,
              recommended_cost: body.recommended_cost,
              message: body.message,
            });
            continue;
          }
          if (!response.ok || body.error) {
            failed += 1;
            results.push({
              mid: item.mid,
              title: item.title,
              status: "error",
              httpStatus: response.status,
              error: body.error ?? "MouseSearch rejected the request",
            });
            continue;
          }
          added += 1;
          results.push({
            mid: item.mid,
            title: item.title,
            status: "added",
            hash: body.hash,
            message: body.message,
            personal_freeleech_applied: body.personal_freeleech_applied ?? false,
          });
          if (removeOnSuccess) ctx.cart.remove(item.mid);
        } catch (error) {
          failed += 1;
          results.push({
            mid: item.mid,
            title: item.title,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return jsonContent({
        requested: items.length,
        added,
        failed,
        cartSize: ctx.cart.list().length,
        results,
      });
    },
  );
}
