import type { NormalizedTorrent } from "./search.js";

const MAX_ENTRIES = 1000;

/**
 * In-memory, process-wide cache of normalized search results keyed by MID.
 *
 * It lets `cart_add` accept MIDs (including batches) without the caller having
 * to echo back the full torrent object that `search_mam` returned. Entries are
 * bounded (LRU-ish, insertion order) so a long-lived process cannot grow
 * without limit. The cache is intentionally ephemeral: a missing MID produces a
 * clear "search again" error rather than a guessed download link.
 */
export class TorrentCache {
  private readonly map = new Map<string, NormalizedTorrent>();

  remember(torrents: NormalizedTorrent[]): void {
    for (const torrent of torrents) {
      if (!torrent.mid) continue;
      this.map.delete(torrent.mid);
      this.map.set(torrent.mid, torrent);
    }
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(mid: string): NormalizedTorrent | undefined {
    return this.map.get(String(mid));
  }

  size(): number {
    return this.map.size;
  }
}
