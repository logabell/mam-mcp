import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import type { CartItem } from "../cart/store.js";
import { appendPersonalFreeleechFlag, freeleechKind, type NormalizedTorrent } from "../mam/search.js";
import { computeBufferGb } from "../mousesearch/client.js";
import { isParseableSize, parseSizeToGb } from "../util/size.js";
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
  free: z.boolean().default(false).describe("Global freeleech: never costs buffer/ratio"),
  vipFreeleech: z.boolean().default(false).describe("VIP freeleech: costs nothing while the account is VIP"),
  personalFreeleech: z.boolean().default(false).describe("Personal freeleech: costs nothing only if a wedge is spent"),
});

const sharedAddOptions = {
  category: z.string().optional().describe("Torrent-client category override (e.g. 'audiobooks')"),
  customRelativePath: z.string().optional().describe("Organization path override (only if auto-organize is on)"),
  customDestinationPath: z.string().optional().describe("Organization destination override"),
  usePersonalFreeleech: z
    .boolean()
    .optional()
    .describe("Spend a personal freeleech wedge for these items (default false; this consumes bonus-earned wedges)"),
  note: z.string().optional(),
};

type TorrentLike = Pick<
  NormalizedTorrent,
  | "mid"
  | "title"
  | "author"
  | "size"
  | "mainCat"
  | "catname"
  | "filetype"
  | "seriesRaw"
  | "downloadLink"
  | "free"
  | "vipFreeleech"
  | "personalFreeleech"
>;

function toCartItem(
  torrent: TorrentLike,
  options: {
    category?: string;
    customRelativePath?: string;
    customDestinationPath?: string;
    usePersonalFreeleech?: boolean;
    note?: string;
  },
): CartItem {
  return {
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
    usePersonalFreeleech: options.usePersonalFreeleech ?? false,
    category: options.category,
    customRelativePath: options.customRelativePath,
    customDestinationPath: options.customDestinationPath,
    note: options.note,
    addedAt: new Date().toISOString(),
  };
}

function isFreeBuffer(item: CartItem): boolean {
  return Boolean(item.free || item.vipFreeleech || item.personalFreeleech || item.usePersonalFreeleech);
}

async function isInClient(ctx: AppContext, mid: string): Promise<boolean | undefined> {
  try {
    return (await ctx.mouseSearch.resolveMid(mid)).found;
  } catch {
    return undefined;
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

interface CartPreviewItem {
  mid: string;
  title: string;
  size?: string;
  freeleech: string;
  buffer_cost_gb: number | null;
}

async function previewCart(ctx: AppContext, mids?: string[]): Promise<Record<string, unknown>> {
  const wanted = mids && mids.length > 0 ? new Set(mids) : null;
  const items = wanted ? ctx.cart.list().filter((item) => wanted.has(item.mid)) : ctx.cart.list();

  let totalGb = 0;
  let freeGb = 0;
  let paidGb = 0;
  let unknownCount = 0;
  const breakdown: CartPreviewItem[] = [];

  for (const item of items) {
    const sizeGb = isParseableSize(item.size) ? parseSizeToGb(item.size) : null;
    const free = isFreeBuffer(item);
    let cost: number | null;
    if (sizeGb === null) {
      unknownCount += 1;
      cost = null;
    } else {
      totalGb += sizeGb;
      if (free) freeGb += sizeGb;
      else paidGb += sizeGb;
      cost = free ? 0 : sizeGb;
    }
    breakdown.push({
      mid: item.mid,
      title: item.title,
      size: item.size || undefined,
      freeleech: freeleechKind(item),
      buffer_cost_gb: cost === null ? null : round2(cost),
    });
  }

  let bufferGb: number | null = null;
  try {
    const userData = await ctx.mouseSearch.getUserData();
    if (userData.ok) bufferGb = computeBufferGb(userData.data);
  } catch {
    bufferGb = null;
  }

  const shortfall = bufferGb !== null && paidGb > bufferGb ? paidGb - bufferGb : 0;
  return {
    itemCount: items.length,
    total_gb: round2(totalGb),
    free_gb: round2(freeGb),
    paid_gb: round2(paidGb),
    unknown_size_count: unknownCount,
    buffer_gb: bufferGb === null ? null : round2(bufferGb),
    sufficient_buffer: bufferGb === null ? null : paidGb <= bufferGb,
    shortfall_gb: round2(shortfall),
    items: breakdown,
  };
}

export function registerCartTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "cart_add",
    {
      title: "Add torrent(s) to download cart",
      description:
        "Add one or more search results to the persistent download cart. This does not download anything; " +
        "call cart_download to commit. Provide exactly one of: `torrent` (a single search result), `torrents` " +
        "(a batch), or `mids` (MIDs previously returned by search_mam in this session). Batch calls report each " +
        "item and flag whether it is already present in the torrent client.",
      inputSchema: {
        torrent: torrentSchema.optional().describe("A single torrent from search_mam"),
        torrents: z.array(torrentSchema).optional().describe("A batch of torrents from search_mam"),
        mids: z
          .array(z.string())
          .optional()
          .describe("MIDs already seen via search_mam in this session; resolved from the search cache"),
        ...sharedAddOptions,
      },
    },
    async (args) => {
      const explicit = [...(args.torrent ? [args.torrent] : []), ...(args.torrents ?? [])];
      const missingMids: string[] = [];
      const fromCache: NormalizedTorrent[] = [];
      for (const mid of args.mids ?? []) {
        const cached = ctx.cache.get(mid);
        if (cached) fromCache.push(cached);
        else missingMids.push(mid);
      }

      const torrents = [...explicit, ...fromCache];
      if (torrents.length === 0 && missingMids.length === 0) {
        return errorContent("cart_add requires `torrent`, `torrents`, or `mids`.");
      }
      if (torrents.length === 0) {
        return errorContent(
          `No cached search results for MID(s): ${missingMids.join(", ")}. Run search_mam first (cache is per-process).`,
        );
      }

      const options = {
        category: args.category,
        customRelativePath: args.customRelativePath,
        customDestinationPath: args.customDestinationPath,
        usePersonalFreeleech: args.usePersonalFreeleech,
        note: args.note,
      };

      const results: Array<Record<string, unknown>> = [];
      let added = 0;
      let updated = 0;
      for (const torrent of torrents) {
        const item = toCartItem(torrent, options);
        const outcome = ctx.cart.add(item);
        if (outcome === "added") added += 1;
        else updated += 1;
        const alreadyInClient = await isInClient(ctx, item.mid);
        results.push({
          mid: item.mid,
          title: item.title,
          outcome,
          freeleech: freeleechKind(torrent),
          alreadyInClient,
        });
      }
      for (const mid of missingMids) {
        results.push({ mid, status: "error", error: "MID not in search cache; run search_mam first" });
      }

      return jsonContent({
        added,
        updated,
        missing: missingMids.length,
        cartSize: ctx.cart.list().length,
        results,
      });
    },
  );

  server.registerTool(
    "cart_list",
    {
      title: "List download cart",
      description: "List the torrents currently queued in the download cart.",
      inputSchema: {
        verbose: z.boolean().optional().describe("Include download links and raw series info (default false)"),
        fields: z.array(z.string()).optional().describe("Limit each item to these top-level fields"),
      },
    },
    async (args) => {
      const select = (item: CartItem): Record<string, unknown> => {
        const record = item as unknown as Record<string, unknown>;
        let view: Record<string, unknown> = args.verbose
          ? { ...record }
          : {
              mid: item.mid,
              title: item.title,
              author: item.author,
              size: item.size,
              catname: item.catname,
              filetype: item.filetype,
              freeleech: freeleechKind(item),
              usePersonalFreeleech: item.usePersonalFreeleech ?? false,
              category: item.category,
              note: item.note,
              addedAt: item.addedAt,
            };
        if (args.fields && args.fields.length > 0) {
          view = Object.fromEntries(args.fields.filter((field) => field in view).map((field) => [field, view[field]]));
        }
        return view;
      };
      const items = ctx.cart.list();
      return jsonContent({ count: items.length, items: items.map(select) });
    },
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
    "cart_preview",
    {
      title: "Preview cart buffer impact",
      description:
        "Dry run of cart_download: totals the cart's size split into free (no buffer cost) and paid, and " +
        "compares the paid portion against the current account buffer. Use this before cart_download to avoid " +
        "an insufficient_buffer rejection and to confirm cost with the user.",
      inputSchema: {
        mids: z.array(z.string()).optional().describe("Optional subset of MIDs; defaults to the whole cart"),
      },
    },
    async (args) => {
      try {
        return jsonContent(await previewCart(ctx, args.mids));
      } catch (error) {
        return errorContent(`cart_preview failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "cart_download",
    {
      title: "Download cart via MouseSearch",
      description:
        "Send every cart item to MouseSearch's /client/add endpoint. MouseSearch performs its own buffer " +
        "checks, freeleech handling, category assignment, path templating, and auto-organization. Nothing is " +
        "added when the account buffer is insufficient. Items already present in the torrent client are skipped " +
        "and reported as already_present. Successful items are removed from the cart by default; failures remain " +
        "so they can be retried or removed. Set dryRun=true to preview without committing.",
      inputSchema: {
        mids: z.array(z.string()).optional().describe("Optional subset of MIDs to download; defaults to the whole cart"),
        removeOnSuccess: z.boolean().optional().describe("Remove successfully added items from the cart (default true)"),
        dryRun: z.boolean().optional().describe("Only preview buffer impact (same as cart_preview); do not download"),
      },
    },
    async (args) => {
      if (args.dryRun) {
        try {
          return jsonContent({ dryRun: true, ...(await previewCart(ctx, args.mids)) });
        } catch (error) {
          return errorContent(`cart_download dryRun failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const all = ctx.cart.list();
      const wanted = args.mids && args.mids.length > 0 ? new Set(args.mids) : null;
      const items = wanted ? all.filter((item) => wanted.has(item.mid)) : all;

      if (items.length === 0) {
        return jsonContent({ requested: 0, added: 0, failed: 0, alreadyPresent: 0, results: [] });
      }

      const removeOnSuccess = args.removeOnSuccess ?? true;
      const results: Array<Record<string, unknown>> = [];
      let added = 0;
      let failed = 0;
      let alreadyPresent = 0;

      for (const item of items) {
        const inClient = await isInClient(ctx, item.mid);
        if (inClient === true) {
          alreadyPresent += 1;
          results.push({
            mid: item.mid,
            title: item.title,
            status: "already_present",
            message: "Already in the torrent client; skipped",
          });
          if (removeOnSuccess) ctx.cart.remove(item.mid);
          continue;
        }

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
        alreadyPresent,
        cartSize: ctx.cart.list().length,
        results,
      });
    },
  );
}
