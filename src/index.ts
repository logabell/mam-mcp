import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { MamClient, redactUrl } from "./mam/client.js";
import { MouseSearchClient } from "./mousesearch/client.js";
import { CartStore } from "./cart/store.js";
import { Logger } from "./util/log.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFilterTools } from "./tools/filters.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCartTools } from "./tools/cart.js";
import { registerStatusTools } from "./tools/status.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "mam-mcp", version: "0.1.0" });
  registerSearchTool(server, ctx);
  registerFilterTools(server, ctx);
  registerAccountTools(server, ctx);
  registerCartTools(server, ctx);
  registerStatusTools(server, ctx);
  return server;
}

function buildContext(): { ctx: AppContext; config: ReturnType<typeof loadConfig>; logger: Logger } {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  logger.addSecret(config.mamId);
  logger.addSecret(config.apiToken);
  if (config.mamProxyUrl) logger.addSecret(config.mamProxyUrl);

  const mam = new MamClient(config, logger);
  const mouseSearch = new MouseSearchClient(config, logger);
  const cart = new CartStore(config.cartFile);
  const ctx = createContext(config, logger, mam, mouseSearch, cart);
  return { ctx, config, logger };
}

async function main(): Promise<void> {
  const { ctx, config, logger } = buildContext();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "mam-mcp", version: "0.1.0" });
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !safeEqual(match[1]!.trim(), config.apiToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.post(config.mcpPath, requireAuth, async (req: Request, res: Response) => {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP endpoint; POST only)." },
      id: null,
    });
  };
  app.get(config.mcpPath, requireAuth, methodNotAllowed);
  app.delete(config.mcpPath, requireAuth, methodNotAllowed);

  const httpServer = app.listen(config.httpBindPort, config.httpBindHost, () => {
    logger.info(`mam-mcp listening on ${config.httpBindHost}:${config.httpBindPort}${config.mcpPath}`);
    logger.info(`MouseSearch base: ${redactUrl(config.mouseSearchUrl)}`);
    logger.info(`Cart file: ${config.cartFile}`);
    logger.info(`MAM proxy: ${config.mamProxyUrl ? redactUrl(config.mamProxyUrl) : "disabled"}`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
