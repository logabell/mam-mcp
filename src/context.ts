import type { Config } from "./config.js";
import type { MamClient } from "./mam/client.js";
import { TorrentCache } from "./mam/cache.js";
import type { MouseSearchClient } from "./mousesearch/client.js";
import { isVipActive } from "./mousesearch/client.js";
import type { CartStore } from "./cart/store.js";
import type { Logger } from "./util/log.js";

const VIP_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AppContext {
  config: Config;
  logger: Logger;
  mam: MamClient;
  mouseSearch: MouseSearchClient;
  cart: CartStore;
  cache: TorrentCache;
  getVipActive(): Promise<boolean>;
}

export function createContext(
  config: Config,
  logger: Logger,
  mam: MamClient,
  mouseSearch: MouseSearchClient,
  cart: CartStore,
): AppContext {
  let cached: { value: boolean; at: number } | null = null;
  const cache = new TorrentCache();

  return {
    config,
    logger,
    mam,
    mouseSearch,
    cart,
    cache,
    async getVipActive(): Promise<boolean> {
      const now = Date.now();
      if (cached && now - cached.at < VIP_CACHE_TTL_MS) return cached.value;
      try {
        const result = await mouseSearch.getUserData();
        const value = result.ok ? isVipActive(result.data) : false;
        cached = { value, at: now };
        return value;
      } catch (error) {
        logger.warn(`VIP status lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        cached = { value: false, at: now };
        return false;
      }
    },
  };
}
