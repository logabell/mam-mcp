import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  const tmpPath = join(dirname(filePath), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}
