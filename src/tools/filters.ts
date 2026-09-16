import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { getLanguages, getMainCategories } from "../mam/maps.js";
import { jsonContent } from "./respond.js";

export function registerFilterTools(server: McpServer, _ctx: AppContext): void {
  server.registerTool(
    "get_filter_options",
    {
      title: "Get MAM filter options",
      description:
        "List valid main categories, subcategories, and languages (with their numeric ids) for use in search_mam.",
      inputSchema: {},
    },
    async () => {
      const mainCategories = getMainCategories().map((category) => ({
        id: category.id,
        name: category.name,
        subcategories: category.subcategories.map((sub) => ({ id: sub.id, name: sub.name })),
      }));
      const languages = Object.entries(getLanguages())
        .map(([name, id]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonContent({ mainCategories, languages });
    },
  );
}
