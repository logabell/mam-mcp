const SIZE_RE = /^[\d.,]+\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i;

const UNITS: Array<{ suffix: string; bytes: number }> = [
  { suffix: "TiB", bytes: 1024 ** 4 },
  { suffix: "GiB", bytes: 1024 ** 3 },
  { suffix: "MiB", bytes: 1024 ** 2 },
  { suffix: "KiB", bytes: 1024 },
  { suffix: "B", bytes: 1 },
];

export function isParseableSize(value: string): boolean {
  return SIZE_RE.test(value.trim());
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  for (const unit of UNITS) {
    if (bytes >= unit.bytes || unit.bytes === 1) {
      const amount = bytes / unit.bytes;
      const rounded = amount >= 100 ? amount.toFixed(1) : amount.toFixed(2);
      return `${rounded.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")} ${unit.suffix}`;
    }
  }
  return `${bytes} B`;
}

/**
 * Normalizes a MAM size value into the "<number> <unit>" string MouseSearch's
 * parse_size_to_gb expects (e.g. "1.5 GiB"). Returns "" when the value cannot
 * be interpreted, so callers can fail closed instead of defaulting to 0 GiB.
 */
export function toSizeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatBytes(value);

  const text = String(value).trim();
  if (text === "") return "";
  if (SIZE_RE.test(text)) return text.replace(/\s+/g, " ");

  if (/^\d+(\.\d+)?$/.test(text)) {
    return formatBytes(Number(text));
  }
  return "";
}

/**
 * Mirrors MouseSearch's parse_size_to_gb: tracker-style size -> GiB-equivalent
 * GB, where GB/GiB are treated as equal and TB is 1024x. Returns null when the
 * value cannot be parsed (callers decide the fallback).
 */
export function parseSizeToGb(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const text = String(value).trim().replace(/,/g, "");
  if (text === "") return null;

  const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*([KMGT]?i?B|[KMGT]?B)?$/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = (match[2] ?? "GB").toUpperCase();
  if (unit === "TIB" || unit === "TB") return amount * 1024;
  if (unit === "GIB" || unit === "GB") return amount;
  if (unit === "MIB" || unit === "MB") return amount / 1024;
  if (unit === "KIB" || unit === "KB") return amount / (1024 * 1024);
  if (unit === "B") return amount / 1024 ** 3;
  return amount;
}
