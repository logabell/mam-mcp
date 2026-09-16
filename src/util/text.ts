const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function unescapeHtml(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

export function normalizeSpaces(text: unknown): string {
  if (text === null || text === undefined) return "";
  return String(text).trim().replace(/\s+/g, " ");
}

export function decodeJsonObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseMamMetadata(raw: unknown, isSeries = false): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    try {
      const parsed = JSON.parse(trimmed);
      return parseMamMetadataValue(parsed, isSeries, trimmed);
    } catch {
      return unescapeHtml(trimmed);
    }
  }
  return parseMamMetadataValue(raw, isSeries, String(raw));
}

function parseMamMetadataValue(value: unknown, isSeries: boolean, fallback: string): string {
  if (!value || typeof value !== "object") {
    return unescapeHtml(fallback);
  }
  const items: string[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (isSeries) {
      if (Array.isArray(entry) && entry.length >= 2) {
        items.push(`${String(entry[0])} #${String(entry[1])}`);
      }
    } else {
      items.push(String(entry));
    }
  }
  if (items.length === 0) return "";
  return unescapeHtml(items.join(", "));
}

export function buildAuthorInitialsVariant(query: string): string | null {
  if (query === null || query === undefined) return null;
  const text = String(query);
  if (!text.trim()) return null;
  if (/[|()"*]/.test(text)) return null;

  const rawTokens = normalizeSpaces(text).split(" ").filter((token) => token.length > 0);
  if (rawTokens.length === 0) return null;

  const hasNonInitialWord = rawTokens.some(
    (token) => token.replace(/[^A-Za-z]/g, "").length >= 3,
  );
  if (!hasNonInitialWord) return null;

  const normalizedTokens: string[] = [];
  let changed = false;

  for (const raw of rawTokens) {
    const token = raw.trim();
    if (!token) continue;
    const stripped = token.replace(/[.,;:!?]+$/g, "").replace(/^[.,;:!?]+/g, "");
    if (!stripped) continue;

    const dottedLetters = stripped.match(/[A-Za-z]/g) ?? [];
    const isDottedInitials =
      stripped.includes(".") && dottedLetters.length >= 2 && /^[A-Za-z.]+$/.test(stripped);
    if (isDottedInitials) {
      normalizedTokens.push(...dottedLetters);
      changed = true;
      continue;
    }

    const lettersOnly = stripped.replace(/[^A-Za-z]/g, "");
    const isInitialCluster =
      lettersOnly.length === 2 && /^[A-Za-z]+$/.test(lettersOnly) && !/[AEIOUaeiou]/.test(lettersOnly);
    if (isInitialCluster) {
      normalizedTokens.push(...lettersOnly.split(""));
      changed = true;
      continue;
    }

    normalizedTokens.push(stripped);
  }

  if (!changed) return null;
  const variant = normalizeSpaces(normalizedTokens.join(" "));
  if (!variant) return null;
  if (variant.toLowerCase() === normalizeSpaces(text).toLowerCase()) return null;
  return variant;
}

const MAIN_CAT_DISPLAY_NAMES: Record<string, string> = {
  "13": "Audiobooks",
  "14": "Ebooks",
  "15": "Musicology",
  "16": "Radio",
};

export function splitCatname(catname: string, mainCat = ""): { category: string; genre: string } {
  const text = String(catname ?? "").trim();
  const separatorIndex = text.indexOf(" - ");
  let category: string;
  let genre: string;
  if (separatorIndex === -1) {
    category = "";
    genre = text;
  } else {
    category = text.slice(0, separatorIndex).trim();
    genre = text.slice(separatorIndex + 3).trim();
  }
  if (!category) {
    category = MAIN_CAT_DISPLAY_NAMES[String(mainCat).trim()] ?? "";
  }
  return { category, genre };
}

export function formatFiletypeToken(filetype: string): string {
  return String(filetype ?? "")
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toUpperCase())
    .join(" ");
}
