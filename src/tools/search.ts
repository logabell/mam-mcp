import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { MamAuthError } from "../mam/client.js";
import { searchMam } from "../mam/search.js";
import { errorContent, jsonContent } from "./respond.js";

export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_mam",
    {
      title: "Search MyAnonamouse",
      description:
        "Search MyAnonamouse. Supports the full advanced-filter set (media type, subcategory, language, " +
        "seeders/leechers/snatches, size range, dates, flags, freeleech). Returns torrents with their MID " +
        "(use as `mid` when adding to the cart). Results use MAM's native ordering (sort=default|seeders|size|date...).",
      inputSchema: {
        query: z.string().optional().describe("Free-text search query"),
        searchInTitle: z.boolean().optional(),
        searchInAuthor: z.boolean().optional(),
        searchInSeries: z.boolean().optional(),
        searchInNarrator: z.boolean().optional(),
        searchInDescription: z.boolean().optional(),
        searchInTags: z.boolean().optional(),
        searchInFilenames: z.boolean().optional(),
        mainCats: z
          .array(z.string())
          .optional()
          .describe('Main categories by name or id, e.g. ["Audiobooks","Ebooks"], or ["all"]. Ids: 13=Audiobooks, 14=Ebooks, 15=Musicology, 16=Radio.'),
        categoryIds: z
          .array(z.string())
          .optional()
          .describe('Subcategories by name or numeric id, e.g. ["Science Fiction","45"]. Use get_filter_options to list them.'),
        languages: z.array(z.string()).optional().describe('Language names or ids, e.g. ["English","Spanish"].'),
        flags: z
          .array(z.string())
          .optional()
          .describe('Browse flag ids, e.g. ["1"] for VIP/freeleech flags. Pair with flagsMode.'),
        flagsMode: z.enum(["show", "hide"]).optional().describe("Whether flags filter shows or hides matches."),
        startDate: z.string().optional().describe("YYYY-MM-DD lower bound on upload date"),
        endDate: z.string().optional().describe("YYYY-MM-DD upper bound on upload date"),
        minSize: z.number().optional().describe("Minimum size in `sizeUnit`"),
        maxSize: z.number().optional().describe("Maximum size in `sizeUnit`"),
        sizeUnit: z.enum(["B", "KB", "KiB", "MB", "MiB", "GB", "GiB", "TB", "TiB"]).optional(),
        minSeeders: z.number().int().optional(),
        maxSeeders: z.number().int().optional(),
        minLeechers: z.number().int().optional(),
        maxLeechers: z.number().int().optional(),
        minSnatched: z.number().int().optional(),
        maxSnatched: z.number().int().optional(),
        searchType: z
          .enum(["all", "active", "fl"])
          .optional()
          .describe("MAM search scope: all, active (has seeders), fl (freeleech)."),
        searchScope: z.string().optional().describe("Advanced MAM tor[searchIn] scope override"),
        sort: z
          .string()
          .optional()
          .describe('MAM sortType, e.g. "default", "seeders", "size", "date", "snatched". Default "default".'),
        page: z.number().int().min(0).optional().describe("Zero-based page index"),
        perPage: z.number().int().min(1).max(200).optional().describe("Results per page (default MAX_RESULTS)"),
      },
    },
    async (args) => {
      try {
        const vipActive = await ctx.getVipActive();
        const outcome = await searchMam(ctx.mam, ctx.config, args, vipActive);
        return jsonContent({
          count: outcome.results.length,
          page: outcome.page,
          perPage: outcome.perPage,
          start: outcome.start,
          resolvedFilters: outcome.resolved,
          results: outcome.results.map((torrent) => ({
            mid: torrent.mid,
            title: torrent.title,
            author: torrent.author,
            narrator: torrent.narrator || undefined,
            series: torrent.series || undefined,
            seriesRaw: torrent.seriesRaw || undefined,
            size: torrent.size || undefined,
            seeders: torrent.seeders,
            leechers: torrent.leechers,
            snatches: torrent.snatches,
            mainCat: torrent.mainCat,
            catname: torrent.catname || undefined,
            filetype: torrent.filetype || undefined,
            free: torrent.free,
            vipFreeleech: torrent.vipFreeleech,
            personalFreeleech: torrent.personalFreeleech,
            language: torrent.language || undefined,
            added: torrent.added || undefined,
            downloadLink: torrent.downloadLink || undefined,
          })),
        });
      } catch (error) {
        if (error instanceof MamAuthError) {
          return errorContent(error.message);
        }
        return errorContent(`search_mam failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
