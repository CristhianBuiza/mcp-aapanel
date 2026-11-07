#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { TargetRegistry } from "./targets.js";
import { registerTools } from "./tools.js";

const packageFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

try {
  process.loadEnvFile(process.env.AAPANEL_ENV_FILE || packageFile(".env"));
} catch {
  // No .env next to the package: rely on the environment provided by the MCP client.
}

let registry: TargetRegistry;
try {
  const config = loadConfig(process.env.AAPANEL_TARGETS_FILE || packageFile("targets.json"));
  registry = new TargetRegistry(
    config,
    process.env.AAPANEL_DOMAIN_MAP_FILE || packageFile("domain-map.json"),
  );
  console.error(
    `aapanel-vps: ${config.targets.length} target(s) from ${config.source}: ` +
      registry
        .describe()
        .map((t) => `${t.name}${t.default ? " (default)" : ""}${t.readOnly ? " (read-only)" : ""}`)
        .join(", "),
  );
} catch (error) {
  console.error(`aapanel-vps: ${(error as Error).message}`);
  process.exit(1);
}

const server = new McpServer({ name: "aapanel-vps", version: "1.1.0" });
registerTools(server, registry);
await server.connect(new StdioServerTransport());
