import categoryData from "./categoryData.json" with { type: "json" };

export interface Subcategory {
  id: string;
  name: string;
}

export interface MainCategory {
  id: string;
  name: string;
  subcategories: Subcategory[];
}

interface CategoryData {
  mainCategories: MainCategory[];
  languages: Record<string, number>;
}

const data = categoryData as CategoryData;

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function getMainCategories(): MainCategory[] {
  return data.mainCategories;
}

export function findMainCategory(value: string): MainCategory | undefined {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  const normalized = normalizeName(value);
  return data.mainCategories.find(
    (category) =>
      category.id === needle ||
      category.name.toLowerCase() === needle ||
      normalizeName(category.name) === normalized,
  );
}

export function findSubcategory(value: string): { mainCategory: MainCategory; subcategory: Subcategory } | undefined {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  const normalized = normalizeName(value);
  for (const mainCategory of data.mainCategories) {
    const subcategory = mainCategory.subcategories.find(
      (entry) =>
        entry.id === needle ||
        entry.name.toLowerCase() === needle ||
        normalizeName(entry.name) === normalized,
    );
    if (subcategory) return { mainCategory, subcategory };
  }
  return undefined;
}

export function getLanguages(): Record<string, number> {
  return data.languages;
}

export function resolveLanguageIds(values: string[]): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  const byName = new Map<string, number>(
    Object.entries(data.languages).map(([name, id]) => [name.toLowerCase(), id]),
  );
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      ids.push(trimmed);
      continue;
    }
    const id = byName.get(trimmed.toLowerCase());
    if (id === undefined) {
      unknown.push(trimmed);
    } else {
      ids.push(String(id));
    }
  }
  return { ids: [...new Set(ids)], unknown };
}
