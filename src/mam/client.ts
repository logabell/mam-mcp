import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Config } from "../config.js";
import { readJsonFile, writeJsonFileAtomic } from "../util/fs.js";
import type { Logger } from "../util/log.js";

const USER_AGENT = "mam-mcp/0.1 (+self-hosted)";

interface PersistedState {
  mam_id?: string;
  updated_at?: string;
}

export class MamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MamAuthError";
  }
}

export interface RequestOptions {
  params?: Array<[string, string]> | URLSearchParams;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class MamClient {
  private readonly baseUrl: string;
  private readonly stateFile: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Dispatcher | undefined;
  private mamId: string;
  private readonly logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.baseUrl = config.mamApiBase;
    this.stateFile = config.mamStateFile;
    this.timeoutMs = config.mamRequestTimeoutMs;
    this.logger = logger;

    const persisted = readJsonFile<PersistedState>(this.stateFile);
    const configured = config.mamId.trim();
    const stored = (persisted?.mam_id ?? "").trim();
    // A new configured value wins over the stored rotated value; otherwise reuse
    // the last rotated cookie so restarts keep a live session.
    this.mamId = configured !== "" && configured !== stored ? configured : stored || configured;
    if (this.mamId === configured) {
      this.persist();
    }

    if (config.mamProxyUrl) {
      const scheme = config.mamProxyUrl.split("://")[0]?.toLowerCase() ?? "";
      if (scheme.startsWith("socks")) {
        throw new Error(
          "MAM_PROXY_URL uses SOCKS, which this server does not support. " +
            "Use gluetun's HTTP proxy instead (e.g. http://gluetun:8888).",
        );
      }
      this.dispatcher = new ProxyAgent(config.mamProxyUrl);
      this.logger.info(`MAM requests routed through proxy ${redactUrl(config.mamProxyUrl)}`);
    }
  }

  private persist(): void {
    writeJsonFileAtomic(this.stateFile, {
      mam_id: this.mamId,
      updated_at: new Date().toISOString(),
    } satisfies PersistedState);
  }

  private cookieHeader(): string {
    return `mam_id=${this.mamId}`;
  }

  private absorbCookies(response: Awaited<ReturnType<typeof fetch>>): void {
    const setCookies =
      typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    let rotated = false;
    for (const line of setCookies) {
      const pair = line.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name === "mam_id" && value && value !== this.mamId) {
        this.mamId = value;
        rotated = true;
      }
    }
    if (rotated) {
      this.persist();
      this.logger.debug("Rotated MAM session cookie persisted");
    }
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Awaited<ReturnType<typeof fetch>>> {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (options.params) {
      const entries =
        options.params instanceof URLSearchParams
          ? [...options.params.entries()]
          : options.params;
      for (const [key, value] of entries) url.searchParams.append(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      return await fetch(url, {
        method,
        headers: {
          Cookie: this.cookieHeader(),
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/plain, */*",
          ...options.headers,
        },
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request("GET", path, options);
    if (response.status === 401 || response.status === 403) {
      throw new MamAuthError(
        `MAM rejected the session (HTTP ${response.status}). Check MAM_ID and that the session allows this server's egress IP/ASN.`,
      );
    }
    if (!response.ok) {
      throw new Error(`MAM request failed: HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MamAuthError(
        "MAM returned a non-JSON response (likely a login/error page). The session cookie may be expired or this server's egress IP/ASN is not allowed for the session.",
      );
    }
  }
}

export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
