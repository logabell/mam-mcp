import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { MamAuthError } from "../mam/client.js";
import { freeleechKind, searchMam, type NormalizedTorrent, type SearchOutcome } from "../mam/search.js";
import { errorContent, jsonContent } from "./respond.js";

interface EditionEntry {
  mid: string;
  title: string;
  author: string;
  format: "audiobook" | "ebook" | "other";
  size?: string;
  filetype?: string;
  seeders: number;
  freeleech: string;
  added?: string;
}

interface EditionGroup {
  title: string;
  authors: string[];
  entries: EditionEntry[];
}

function normalizedTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatOf(torrent: NormalizedTorrent): EditionEntry["format"] {
  if (torrent.mainCat === "13") return "audiobook";
  if (torrent.mainCat === "14") return "ebook";
  return "other";
}

function groupEditions(results: NormalizedTorrent[]): EditionGroup[] {
  const groups = new Map<string, EditionGroup>();
  for (const torrent of results) {
    const key = normalizedTitleKey(torrent.title);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { title: torrent.title, authors: [], entries: [] };
      groups.set(key, group);
    }
    if (torrent.author && !group.authors.includes(torrent.author)) group.authors.push(torrent.author);
    group.entries.push({
      mid: torrent.mid,
      title: torrent.title,
      author: torrent.author,
      format: formatOf(torrent),
      size: torrent.size || undefined,
      filetype: torrent.filetype || undefined,
      seeders: torrent.seeders,
      freeleech: freeleechKind(torrent),
      added: torrent.added || undefined,
    });
  }
  return [...groups.values()].filter((group) => group.entries.length > 0);
}

function resultView(torrent: NormalizedTorrent): Record<string, unknown> {
  return {
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
    freeleech: freeleechKind(torrent),
    language: torrent.language || undefined,
    added: torrent.added || undefined,
    downloadLink: torrent.downloadLink || undefined,
  };
}

function paginationView(outcome: SearchOutcome): Record<string, unknown> {
  return {
    count: outcome.results.length,
    page: outcome.page,
    perPage: outcome.perPage,
    start: outcome.start,
    nextOffset: outcome.nextOffset,
    total: outcome.total,
    hasMore: outcome.hasMore,
  };
}

export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_mam",
    {
      title: "Search MyAnonamouse",
      description:
        "Search MyAnonamouse. Supports the full advanced-filter set (media type, subcategory, language, " +
        "seeders/leechers/snatches, size range, dates, flags, freeleech). Returns torrents with their MID " +
        "(use as `mid` when adding to the cart). Results use MAM's native ordering (sort=default|seeders|size|date...). " +
        "`startDate`/`endDate` filter the date the torrent was ADDED to MAM, not its publication year. " +
        "Set groupEditions=true to get results grouped by title so audiobook/ebook editions of the same book " +
        "are returned together.",
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
        startDate: z.string().optional().describe("YYYY-MM-DD lower bound on the date the torrent was added to MAM"),
        endDate: z.string().optional().describe("YYYY-MM-DD upper bound on the date the torrent was added to MAM"),
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
        groupEditions: z
          .boolean()
          .optional()
          .describe("Group results by title so audiobook/ebook editions of the same book appear together."),
      },
    },
    async (args) => {
      try {
        const vipActive = await ctx.getVipActive();
        const { groupEditions: shouldGroup, ...searchArgs } = args;
        const outcome = await searchMam(ctx.mam, ctx.config, searchArgs, vipActive);
        ctx.cache.remember(outcome.results);

        return jsonContent({
          ...paginationView(outcome),
          resolvedFilters: outcome.resolved,
          results: outcome.results.map(resultView),
          ...(shouldGroup ? { editions: groupEditions(outcome.results) } : {}),
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
