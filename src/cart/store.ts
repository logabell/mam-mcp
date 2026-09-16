import { readJsonFile, writeJsonFileAtomic } from "../util/fs.js";

export interface CartItem {
  mid: string;
  title: string;
  author: string;
  size: string;
  mainCat: string;
  catname: string;
  filetype: string;
  seriesInfo: string;
  downloadLink: string;
  free: boolean;
  vipFreeleech: boolean;
  personalFreeleech: boolean;
  usePersonalFreeleech?: boolean;
  category?: string;
  customRelativePath?: string;
  customDestinationPath?: string;
  note?: string;
  addedAt: string;
}

interface CartFile {
  items: CartItem[];
}

export class CartStore {
  private readonly filePath: string;
  private items: CartItem[];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    const loaded = readJsonFile<CartFile>(filePath);
    this.items = Array.isArray(loaded?.items) ? loaded!.items : [];
  }

  list(): CartItem[] {
    return [...this.items];
  }

  get(mid: string): CartItem | undefined {
    return this.items.find((item) => item.mid === mid);
  }

  add(item: CartItem): "added" | "updated" {
    const index = this.items.findIndex((entry) => entry.mid === item.mid);
    if (index === -1) {
      this.items.push(item);
      this.persist();
      return "added";
    }
    this.items[index] = { ...this.items[index], ...item, addedAt: this.items[index]!.addedAt };
    this.persist();
    return "updated";
  }

  remove(mid: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.mid !== mid);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    this.persist();
    return count;
  }

  private persist(): void {
    const snapshot = { items: this.items };
    this.writeChain = this.writeChain.then(
      () => writeJsonFileAtomic(this.filePath, snapshot),
      () => writeJsonFileAtomic(this.filePath, snapshot),
    );
  }
}
