#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, userConfigDir } from "./config.js";
import { runSetup } from "./setup.js";
import { TargetRegistry } from "./targets.js";
import { registerTools } from "./tools.js";

const packageFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const userTargetsFile = join(userConfigDir(), "targets.json");

const command = process.argv[2];
if (command === "setup") process.exit(await runSetup(process.env.AAPANEL_TARGETS_FILE || userTargetsFile));
if (command) {
  console.error(`Unknown command "${command}". Usage: aapanel-vps [setup]`);
  process.exit(1);
}

try {
  process.loadEnvFile(process.env.AAPANEL_ENV_FILE || packageFile(".env"));
} catch {
  // No .env next to the package: rely on the environment provided by the MCP client.
}

// Precedence: AAPANEL_TARGETS_FILE > saved setup > targets.json next to the package > AAPANEL_* variables.
const targetsFile =
  process.env.AAPANEL_TARGETS_FILE ||
  [userTargetsFile, packageFile("targets.json")].find((file) => existsSync(file)) ||
  userTargetsFile;
const domainMapFile =
  process.env.AAPANEL_DOMAIN_MAP_FILE ||
  (existsSync(targetsFile) ? join(dirname(targetsFile), "domain-map.json") : packageFile("domain-map.json"));

let registry: TargetRegistry;
try {
  const config = loadConfig(targetsFile);
  registry = new TargetRegistry(config, domainMapFile);
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
