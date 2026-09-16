import type { Config } from "../config.js";
import { toSizeString } from "../util/size.js";
import { buildAuthorInitialsVariant, unescapeHtml } from "../util/text.js";
import type { MamClient } from "./client.js";
import { findMainCategory, findSubcategory, resolveLanguageIds } from "./maps.js";

export interface SearchInput {
  query?: string;
  searchInTitle?: boolean;
  searchInAuthor?: boolean;
  searchInSeries?: boolean;
  searchInNarrator?: boolean;
  searchInDescription?: boolean;
  searchInTags?: boolean;
  searchInFilenames?: boolean;
  mainCats?: string[];
  categoryIds?: string[];
  languages?: string[];
  flags?: string[];
  flagsMode?: "show" | "hide";
  startDate?: string;
  endDate?: string;
  minSize?: number;
  maxSize?: number;
  sizeUnit?: string;
  minSeeders?: number;
  maxSeeders?: number;
  minLeechers?: number;
  maxLeechers?: number;
  minSnatched?: number;
  maxSnatched?: number;
  searchType?: string;
  searchScope?: string;
  sort?: string;
  page?: number;
  offset?: number;
  perPage?: number;
}

export interface NormalizedTorrent {
  mid: string;
  title: string;
  author: string;
  narrator: string;
  series: string;
  seriesRaw: string;
  size: string;
  seeders: number;
  leechers: number;
  snatches: number;
  mainCat: string;
  catname: string;
  filetype: string;
  free: boolean;
  vipFreeleech: boolean;
  personalFreeleech: boolean;
  downloadLink: string;
  language: string;
  added: string;
}

export interface SearchOutcome {
  results: NormalizedTorrent[];
  page: number;
  perPage: number;
  offset: number;
  start: number;
  resolved: {
    mainCats: string[];
    categoryIds: string[];
    languageIds: string[];
    unknownLanguages: string[];
    unknownMainCats: string[];
    unknownCategories: string[];
  };
}

const SEARCH_FIELD_KEYS: Array<keyof SearchInput> = [
  "searchInTitle",
  "searchInAuthor",
  "searchInSeries",
  "searchInNarrator",
  "searchInDescription",
  "searchInTags",
  "searchInFilenames",
];

function toFieldName(key: keyof SearchInput): string {
  return key.replace("searchIn", "").toLowerCase();
}

function buildDownloadLink(base: string, dl: unknown, id: unknown): string {
  const normalizedDl = String(dl ?? "").trim();
  const normalizedTid = String(id ?? "").trim();
  if (!normalizedDl || !normalizedTid) return "";
  let parsed: URL;
  try {
    parsed = new URL(`${base}${normalizedDl}`);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const part of parsed.search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const key = decodeURIComponent(part.split("=")[0] ?? "").trim().toLowerCase();
    if (key !== "tid") parts.push(part);
  }
  parts.push(`tid=${normalizedTid}`);
  parsed.search = parts.join("&");
  return parsed.toString();
}

export function appendPersonalFreeleechFlag(rawUrl: string): string {
  const normalized = String(rawUrl ?? "").trim();
  if (!normalized) return normalized;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }
  if ([...parsed.searchParams.keys()].some((key) => key === "fl")) return normalized;
  const existing = parsed.search.replace(/^\?/, "");
  parsed.search = existing ? `${existing}&fl` : "fl";
  return parsed.toString();
}

export function normalizeResult(item: Record<string, unknown>, base: string, vipActive: boolean): NormalizedTorrent {
  const id = String(item.id ?? "").trim();
  const filetype = String(item.filetype ?? item.filetypes ?? "").trim();
  const flVip = Number(item.fl_vip ?? 0) === 1 || item.fl_vip === true;
  return {
    mid: id,
    title: unescapeHtml(String(item.title ?? "").trim()),
    author: parseAuthors(item.author_info),
    narrator: parseAuthors(item.narrator_info),
    series: parseSeries(item.series_info),
    seriesRaw: String(item.series_info ?? ""),
    size: toSizeString(item.size),
    seeders: Number(item.seeders ?? 0) || 0,
    leechers: Number(item.leechers ?? 0) || 0,
    snatches: Number(item.snatched ?? 0) || 0,
    mainCat: String(item.main_cat ?? "").trim(),
    catname: unescapeHtml(String(item.catname ?? "").trim()),
    filetype,
    free: Number(item.free ?? 0) === 1 || item.free === true,
    vipFreeleech: flVip && vipActive,
    personalFreeleech: Number(item.personal_freeleech ?? 0) === 1 || item.personal_freeleech === true,
    downloadLink: buildDownloadLink(base, item.dl, item.id),
    language: String(item.language ?? item.lang_code ?? "").trim(),
    added: String(item.added ?? item.date ?? "").trim(),
  };
}

function parseAuthors(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return unescapeHtml(Object.values(parsed as Record<string, unknown>).map(String).join(", "));
    }
  } catch {
    /* fall through to plain string */
  }
  return unescapeHtml(text);
}

function parseSeries(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const parts: string[] = [];
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value) && value.length >= 2) parts.push(`${String(value[0])} #${String(value[1])}`);
      }
      return unescapeHtml(parts.join(", "));
    }
  } catch {
    /* fall through to plain string */
  }
  return unescapeHtml(text);
}

export async function searchMam(
  client: MamClient,
  config: Config,
  input: SearchInput,
  vipActive: boolean,
): Promise<SearchOutcome> {
  const params = new URLSearchParams();

  const perPage = Math.min(Math.max(input.perPage ?? config.maxResults, 1), 200);
  const page = Math.max(input.page ?? 0, 0);
  const offset = input.offset ?? page * perPage;

  params.set("tor[sortType]", input.sort?.trim() || "default");
  params.set("perpage", String(perPage));
  params.set("tor[startNumber]", String(offset));
  params.set("thumbnail", "true");
  params.set("dlLink", "true");
  params.set("isbn", "true");
  params.set("description", "true");
  params.set("mediaInfo", "true");
  params.set("tor[searchType]", input.searchType?.trim() || "all");

  const languageInput = input.languages && input.languages.length > 0 ? input.languages : [config.defaultLanguage];
  const { ids: languageIds, unknown: unknownLanguages } = resolveLanguageIds(languageInput);
  for (const id of languageIds) params.append("tor[browse_lang][]", id);

  const explicitFields = SEARCH_FIELD_KEYS.filter((key) => input[key] !== undefined);
  const defaults = { searchInTitle: true, searchInAuthor: true, searchInSeries: true };
  const resolvedFieldValue = (key: keyof SearchInput): boolean => {
    if (input[key] !== undefined) return Boolean(input[key]);
    if (explicitFields.length === 0) return Boolean(defaults[key as keyof typeof defaults]);
    return false;
  };
  for (const key of SEARCH_FIELD_KEYS) {
    if (resolvedFieldValue(key)) params.set(`tor[srchIn][${toFieldName(key)}]`, "true");
  }

  const query = (input.query ?? "").trim();
  if (query) {
    let searchText = query;
    if (resolvedFieldValue("searchInAuthor")) {
      const variant = buildAuthorInitialsVariant(query);
      if (variant) {
        const quoted = variant.replace(/"/g, "").trim();
        if (quoted) searchText = `(${query} | "${quoted}")`;
      }
    }
    params.set("tor[text]", searchText);
  }

  const mainCats: string[] = [];
  const unknownMainCats: string[] = [];
  for (const raw of input.mainCats ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === "all") continue;
    if (/^\d+$/.test(trimmed)) {
      mainCats.push(trimmed);
      continue;
    }
    const match = findMainCategory(trimmed);
    if (match) mainCats.push(match.id);
    else unknownMainCats.push(trimmed);
  }
  if (mainCats.length > 0) {
    for (const id of [...new Set(mainCats)]) params.append("tor[main_cat][]", id);
  }

  const categoryIds: string[] = [];
  const unknownCategories: string[] = [];
  for (const raw of input.categoryIds ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      categoryIds.push(trimmed);
      continue;
    }
    const match = findSubcategory(trimmed);
    if (match) categoryIds.push(match.subcategory.id);
    else unknownCategories.push(trimmed);
  }
  for (const id of [...new Set(categoryIds)]) params.append("tor[cat][]", id);

  if (input.flags && input.flags.length > 0) {
    for (const flag of input.flags) {
      const trimmed = String(flag).trim();
      if (trimmed) params.append("tor[browseFlags][]", trimmed);
    }
    params.set("tor[browseFlagsHideVsShow]", input.flagsMode === "hide" ? "1" : "0");
  }

  if (input.startDate) params.set("tor[startDate]", input.startDate.trim());
  if (input.endDate) params.set("tor[endDate]", input.endDate.trim());

  if (input.minSize !== undefined) params.set("tor[minSize]", String(input.minSize));
  if (input.maxSize !== undefined) params.set("tor[maxSize]", String(input.maxSize));
  if ((input.minSize !== undefined || input.maxSize !== undefined) && input.sizeUnit) {
    params.set("tor[unit]", input.sizeUnit.trim());
  }

  const statMapping: Array<[keyof SearchInput, string]> = [
    ["minSeeders", "tor[minSeeders]"],
    ["maxSeeders", "tor[maxSeeders]"],
    ["minLeechers", "tor[minLeechers]"],
    ["maxLeechers", "tor[maxLeechers]"],
    ["minSnatched", "tor[minSnatched]"],
    ["maxSnatched", "tor[maxSnatched]"],
  ];
  for (const [key, paramName] of statMapping) {
    const value = input[key];
    if (value !== undefined && value !== null) params.set(paramName, String(value));
  }

  if (input.searchScope) params.set("tor[searchIn]", input.searchScope.trim());

  const json = await client.getJson<{ data?: Array<Record<string, unknown>> }>(
    "/tor/js/loadSearchJSONbasic.php",
    { params },
  );
  const rawResults = Array.isArray(json.data) ? json.data : [];
  const base = `${config.mamApiBase}/tor/download.php/`;
  const results = rawResults.map((item) => normalizeResult(item, base, vipActive));

  return {
    results,
    page,
    perPage,
    offset,
    start: offset,
    resolved: {
      mainCats: [...new Set(mainCats)],
      categoryIds: [...new Set(categoryIds)],
      languageIds,
      unknownLanguages,
      unknownMainCats,
      unknownCategories,
    },
  };
}
