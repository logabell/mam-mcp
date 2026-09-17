import type { Config } from "../config.js";
import { parseSizeToGb } from "../util/size.js";
import type { Logger } from "../util/log.js";

export interface MouseSearchResult<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

export interface AddTorrentResult {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
}

export interface MamUserData {
  seedbonus?: number;
  uploaded?: number | string;
  downloaded?: number | string;
  ratio?: number | string;
  vip_until?: string;
  [key: string]: unknown;
}

export class MouseSearchClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.baseUrl = config.mouseSearchUrl;
    this.timeoutMs = config.mouseSearchTimeoutMs;
    this.logger = logger;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<MouseSearchResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
      if (response.redirected || looksHtml) {
        this.logger.error(
          `MouseSearch returned a non-API response at ${path} (redirected=${response.redirected}, contentType=${contentType || "unknown"})`,
        );
        throw new Error(
          "MouseSearch returned HTML/redirect (likely a PocketID/auth proxy in front of the API). " +
            "Point MOUSESEARCH_URL at the internal address (e.g. http://mousesearch:5000) — the public hostname is UI-only.",
        );
      }
      let data: unknown = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 2000) };
        }
      }
      return { status: response.status, ok: response.ok, data: data as T };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`MouseSearch request failed: ${path}: ${message}`);
      throw new Error(`MouseSearch request to ${path} failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus(): Promise<MouseSearchResult> {
    return this.request("/client/status");
  }

  async getUserData(): Promise<MouseSearchResult<MamUserData>> {
    return this.request<MamUserData>("/mam/user_data");
  }

  async getCategories(): Promise<MouseSearchResult> {
    return this.request("/client/categories");
  }

  async addTorrent(payload: Record<string, unknown>): Promise<AddTorrentResult> {
    const result = await this.request<Record<string, unknown>>("/client/add", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { status: result.status, ok: result.ok, data: result.data ?? {} };
  }

  async resolveMid(mid: string): Promise<{ found: boolean; hash?: string; status: number }> {
    const result = await this.request<{ hash?: string; error?: string }>("/client/resolve_mid", {
      method: "POST",
      body: JSON.stringify({ mid }),
    });
    const hash = typeof result.data?.hash === "string" ? result.data.hash : undefined;
    return { found: result.ok && Boolean(hash), hash, status: result.status };
  }

  async getTorrentInfoBatch(hashes: string[]): Promise<Record<string, unknown>> {
    const result = await this.request<{ torrents?: Record<string, unknown> }>("/client/info/batch", {
      method: "POST",
      body: JSON.stringify({ hashes }),
    });
    return result.data?.torrents ?? {};
  }
}

export function computeBufferGb(userData: MamUserData | null): number | null {
  if (!userData) return null;
  const uploaded = parseSizeToGb(userData.uploaded);
  const downloaded = parseSizeToGb(userData.downloaded);
  if (uploaded === null || downloaded === null) return null;
  return uploaded - downloaded;
}

export function isVipActive(userData: MamUserData | null, now = new Date()): boolean {
  const raw = userData?.vip_until;
  if (!raw) return false;
  const normalized = String(raw).trim().replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() > now.getTime();
}
