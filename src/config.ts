export interface Config {
  mamId: string;
  mamApiBase: string;
  mamProxyUrl?: string;
  mamStateFile: string;
  mamRequestTimeoutMs: number;
  mouseSearchUrl: string;
  mouseSearchTimeoutMs: number;
  defaultCategory: string;
  defaultLanguage: string;
  maxResults: number;
  httpBindHost: string;
  httpBindPort: number;
  apiToken: string;
  mcpPath: string;
  cartFile: string;
  logLevel: string;
}

function str(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

function optionalStr(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function int(value: string | undefined, fallback: number, name: string): number {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

function parseBind(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`MCP_HTTP_BIND must be HOST:PORT, received "${value}"`);
  }
  const host = trimmed.slice(0, lastColon).trim() || "0.0.0.0";
  const port = Number(trimmed.slice(lastColon + 1).trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in MCP_HTTP_BIND: ${value}`);
  }
  return { host, port };
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") return "/mcp";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mamId = str(env.MAM_ID, "");
  if (!mamId) {
    throw new Error("MAM_ID is required (dedicated MyAnonamouse session cookie for this MCP)");
  }

  const apiToken = str(env.MCP_API_TOKEN, "");
  if (apiToken.length < 16) {
    throw new Error("MCP_API_TOKEN is required and must be at least 16 characters");
  }

  const { host, port } = parseBind(str(env.MCP_HTTP_BIND, "0.0.0.0:8765"));

  return {
    mamId,
    mamApiBase: str(env.MAM_API_BASE, "https://www.myanonamouse.net").replace(/\/+$/, ""),
    mamProxyUrl: optionalStr(env.MAM_PROXY_URL),
    mamStateFile: str(env.MAM_STATE_FILE, "./data/mam-state.json"),
    mamRequestTimeoutMs: int(env.MAM_REQUEST_TIMEOUT_MS, 20000, "MAM_REQUEST_TIMEOUT_MS"),
    mouseSearchUrl: str(env.MOUSESEARCH_URL, "http://mousesearch:5000").replace(/\/+$/, ""),
    mouseSearchTimeoutMs: int(env.MOUSESEARCH_TIMEOUT_MS, 30000, "MOUSESEARCH_TIMEOUT_MS"),
    defaultCategory: str(env.DEFAULT_CATEGORY, "audiobooks"),
    defaultLanguage: str(env.DEFAULT_LANGUAGE, "English"),
    maxResults: int(env.MAX_RESULTS, 50, "MAX_RESULTS"),
    httpBindHost: host,
    httpBindPort: port,
    apiToken,
    mcpPath: normalizePath(str(env.MCP_PATH, "/mcp")),
    cartFile: str(env.CART_FILE, "./data/cart.json"),
    logLevel: str(env.APP_LOG_LEVEL, "INFO").toUpperCase(),
  };
}
