import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AaPanelClient, Params } from "./client.js";
import type { SshRunner } from "./ssh.js";
import { normalizeDomain, type Resolution, type Target, type TargetRegistry } from "./targets.js";

const MAX_OUTPUT_CHARS = 100_000;

interface ToolContext {
  target: Target;
  panel: AaPanelClient;
  ssh: SshRunner;
}

interface ToolSpec<S extends z.ZodRawShape> {
  title: string;
  description: string;
  input: S;
  /** Which connection the tool uses; decides whether it is registered at all. */
  uses?: "panel" | "ssh" | "none";
  /** Modifies the server. Rejected on read-only targets. */
  write?: boolean;
  destructive?: boolean;
  /** Domain the call is about, used to pick the target when none is given. */
  domain?: (args: z.infer<z.ZodObject<S>>) => string | undefined;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

function toResult(data: unknown, resolution?: Resolution) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${text.length} chars total]`;
  }
  if (resolution) text = `[target: ${resolution.target.name} — ${resolution.reason}]\n${text}`;
  const failed =
    typeof data === "object" && data !== null && (data as { status?: unknown }).status === false;
  return { content: [{ type: "text" as const, text }], isError: failed };
}

function contextFor(target: Target): ToolContext {
  return {
    target,
    get panel() {
      if (!target.panel) throw new Error(`Target "${target.name}" has no aaPanel configured`);
      return target.panel;
    },
    get ssh() {
      if (!target.ssh) throw new Error(`Target "${target.name}" has no SSH access configured`);
      return target.ssh;
    },
  };
}

const page = z.number().int().min(1).default(1).describe("Page number");
const limit = z.number().int().min(1).max(500).default(20).describe("Items per page");
const siteId = z.number().int().describe("Site ID (from aapanel_list_sites)");
const siteName = z.string().describe("Site name, usually its main domain (from aapanel_list_sites)");

export function registerTools(server: McpServer, registry: TargetRegistry) {
  const targets = registry.all();
  const names = targets.map((t) => t.name);
  const targetParam = z
    .string()
    .optional()
    .describe(
      `Target server (${names.join(", ")}). Omit to pick it from the domain or use the default "${registry.defaultTarget.name}".`,
    );

  const tool = <S extends z.ZodRawShape>(name: string, spec: ToolSpec<S>) => {
    const uses = spec.uses ?? "panel";
    const eligible = targets.filter(
      (t) => (uses === "panel" ? t.panel : uses === "ssh" ? t.ssh : true) && !(spec.write && t.readOnly),
    );
    if (eligible.length === 0) return;

    const input = uses === "none" ? spec.input : { ...spec.input, target: targetParam };
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: input,
        annotations: {
          readOnlyHint: !spec.write,
          destructiveHint: spec.destructive ?? false,
          openWorldHint: uses !== "none",
        },
      },
      // The SDK's generic callback type does not narrow from our ToolSpec generic.
      (async (rawArgs: z.infer<z.ZodObject<S>> & { target?: string }) => {
        try {
          if (uses === "none") return toResult(await spec.run(rawArgs, contextFor(registry.defaultTarget)));
          const { target, ...args } = rawArgs;
          const typedArgs = args as z.infer<z.ZodObject<S>>;
          const resolution = await registry.resolve(target, spec.domain?.(typedArgs));
          if (spec.write && resolution.target.readOnly) {
            throw new Error(`Target "${resolution.target.name}" is read-only`);
          }
          return toResult(await spec.run(typedArgs, contextFor(resolution.target)), resolution);
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
            isError: true,
          };
        }
      }) as never,
    );
  };

  const getData = (panel: AaPanelClient, table: string, params: Params) =>
    panel.call(`/data?action=getData&table=${table}`, { tojs: "", ...params });

  // ---------------------------------------------------------------- Targets

  tool("targets_list", {
    title: "List targets",
    description:
      "Lists the configured servers (targets) with their aaPanel URL, SSH host and the domains assigned to each. No secrets are returned.",
    input: {},
    uses: "none",
    run: async () => registry.describe(),
  });

  tool("targets_find_domain", {
    title: "Find which target hosts a domain",
    description:
      "Shows which target a domain resolves to and searches every aaPanel's site list for it.",
    input: { domain: z.string().describe("Domain or subdomain, e.g. shop.example.com") },
    uses: "none",
    run: async ({ domain }) => {
      const [resolution, sites] = await Promise.all([
        registry.resolve(undefined, domain).catch((e: Error) => ({ error: e.message })),
        registry.discover(normalizeDomain(domain)),
      ]);
      return {
        resolvesTo:
          "error" in resolution ? resolution.error : { target: resolution.target.name, reason: resolution.reason },
        foundInPanels: sites,
      };
    },
  });

  tool("targets_assign_domain", {
    title: "Assign domain to target",
    description:
      "Records that a domain (and its subdomains) lives on a given target, so later calls about it go there automatically. Saved locally; no server is changed.",
    input: {
      domain: z.string().describe("Domain, e.g. example.com"),
      target: z.enum(names as [string, ...string[]]).describe("Target name"),
    },
    uses: "none",
    run: async ({ domain, target }) => {
      registry.assign(domain, target);
      return { assigned: domain, target };
    },
  });

  tool("targets_unassign_domain", {
    title: "Remove domain assignment",
    description: "Removes a domain assignment made with targets_assign_domain.",
    input: { domain: z.string() },
    uses: "none",
    run: async ({ domain }) => ({ removed: registry.unassign(domain), domain }),
  });

  // ---------------------------------------------------------------- System

  tool("aapanel_get_system_info", {
    title: "System info",
    description:
      "Returns OS, panel version, CPU, memory, load, disk usage and network stats. Use it to verify the connection to the panel.",
    input: {},
    run: async (_, { panel }) => {
      const [system, disks, network] = await Promise.all([
        panel.call("/system?action=GetSystemTotal"),
        panel.call("/system?action=GetDiskInfo"),
        panel.call("/system?action=GetNetWork"),
      ]);
      return { system, disks, network };
    },
  });

  tool("aapanel_service_admin", {
    title: "Manage service",
    description:
      "Start, stop, restart or reload a service managed by aaPanel (e.g. nginx, apache, mysqld, redis, pure-ftpd, php-fpm-74, php-fpm-82).",
    input: {
      name: z.string().describe("Service name, e.g. nginx, mysqld, php-fpm-82"),
      action: z.enum(["start", "stop", "restart", "reload"]),
    },
    write: true,
    run: ({ name, action }, { panel }) => panel.call("/system?action=ServiceAdmin", { name, type: action }),
  });

  tool("aapanel_list_software", {
    title: "List software/plugins",
    description:
      "Lists the software and plugins available in the aaPanel App Store, including installation status and versions.",
    input: {
      query: z.string().optional().describe("Filter by name"),
      type: z.number().int().default(0).describe("Category ID; 0 = all"),
      page,
    },
    run: ({ query, type, page }, { panel }) =>
      panel.call("/plugin?action=get_soft_list", { p: page, type, query, tojs: "", force: 0 }),
  });

  tool("aapanel_get_panel_logs", {
    title: "Panel operation logs",
    description: "Returns the panel operation log (logins, changes, tasks).",
    input: { page, limit },
    run: ({ page, limit }, { panel }) => getData(panel, "logs", { p: page, limit }),
  });

  // ---------------------------------------------------------------- Sites

  tool("aapanel_list_sites", {
    title: "List websites",
    description: "Lists websites with their ID, name, path, status, PHP version and expiration.",
    input: {
      search: z.string().optional().describe("Filter by domain or remark"),
      page,
      limit,
    },
    run: ({ search, page, limit }, { panel }) =>
      getData(panel, "sites", { p: page, limit, type: -1, order: "id desc", search }),
  });

  tool("aapanel_get_php_versions", {
    title: "Installed PHP versions",
    description: "Lists the PHP versions installed in the panel (values usable in create_site/set_site_php).",
    input: {},
    run: (_, { panel }) => panel.call("/site?action=GetPHPVersion"),
  });

  tool("aapanel_create_site", {
    title: "Create website",
    description:
      "Creates a new website. Optionally creates an FTP account and a MySQL database for it.",
    input: {
      domain: z.string().describe("Main domain, e.g. example.com"),
      extra_domains: z.array(z.string()).default([]).describe("Additional domains/aliases"),
      path: z.string().optional().describe("Document root; defaults to /www/wwwroot/<domain>"),
      php_version: z
        .string()
        .default("00")
        .describe("PHP version without dot, e.g. 82; '00' for a static site"),
      port: z.number().int().default(80),
      remark: z.string().optional(),
      type_id: z.number().int().default(0).describe("Site category ID"),
      ftp: z
        .object({ username: z.string(), password: z.string() })
        .optional()
        .describe("Create an FTP account for the site"),
      database: z
        .object({
          username: z.string(),
          password: z.string(),
          charset: z.string().default("utf8mb4"),
        })
        .optional()
        .describe("Create a MySQL database (name = username) for the site"),
    },
    write: true,
    domain: (a) => a.domain,
    run: (a, { panel }) =>
      panel.call("/site?action=AddSite", {
        webname: JSON.stringify({
          domain: a.domain,
          domainlist: a.extra_domains,
          count: a.extra_domains.length,
        }),
        path: a.path ?? `/www/wwwroot/${a.domain}`,
        type_id: a.type_id,
        type: "PHP",
        version: a.php_version,
        port: a.port,
        ps: a.remark ?? a.domain,
        ftp: Boolean(a.ftp),
        ftp_username: a.ftp?.username,
        ftp_password: a.ftp?.password,
        sql: a.database ? "MySQL" : false,
        datauser: a.database?.username,
        datapassword: a.database?.password,
        codeing: a.database?.charset,
      }),
  });

  tool("aapanel_delete_site", {
    title: "Delete website",
    description: "Deletes a website. Optionally also deletes its FTP account, database and files.",
    input: {
      id: siteId,
      name: siteName,
      delete_ftp: z.boolean().default(false),
      delete_database: z.boolean().default(false),
      delete_files: z.boolean().default(false).describe("Delete the document root from disk"),
    },
    write: true,
    destructive: true,
    domain: (a) => a.name,
    run: (a, { panel }) =>
      panel.call("/site?action=DeleteSite", {
        id: a.id,
        webname: a.name,
        ftp: a.delete_ftp ? 1 : undefined,
        database: a.delete_database ? 1 : undefined,
        path: a.delete_files ? 1 : undefined,
      }),
  });

  tool("aapanel_set_site_status", {
    title: "Start/stop website",
    description: "Enables (start) or disables (stop) a website.",
    input: { id: siteId, name: siteName, action: z.enum(["start", "stop"]) },
    write: true,
    domain: (a) => a.name,
    run: ({ id, name, action }, { panel }) =>
      panel.call(`/site?action=${action === "start" ? "SiteStart" : "SiteStop"}`, { id, name }),
  });

  tool("aapanel_set_site_php", {
    title: "Change site PHP version",
    description: "Changes the PHP version used by a website.",
    input: {
      name: siteName,
      php_version: z.string().describe("PHP version without dot, e.g. 82; '00' for static"),
    },
    write: true,
    domain: (a) => a.name,
    run: ({ name, php_version }, { panel }) =>
      panel.call("/site?action=SetPHPVersion", { siteName: name, version: php_version }),
  });

  tool("aapanel_list_site_domains", {
    title: "List site domains",
    description: "Lists the domains bound to a website.",
    input: { id: siteId },
    run: ({ id }, { panel }) => getData(panel, "domain", { search: id, list: "True" }),
  });

  tool("aapanel_add_site_domain", {
    title: "Add domain to site",
    description: "Binds one or more domains to a website.",
    input: {
      id: siteId,
      name: siteName,
      domains: z.array(z.string()).min(1).describe("Domains, optionally with port: a.com, b.com:8080"),
    },
    write: true,
    domain: (a) => a.name,
    run: ({ id, name, domains }, { panel }) =>
      panel.call("/site?action=AddDomain", { id, webname: name, domain: domains.join(",") }),
  });

  tool("aapanel_delete_site_domain", {
    title: "Remove domain from site",
    description: "Unbinds a domain from a website.",
    input: { id: siteId, name: siteName, domain: z.string(), port: z.number().int().default(80) },
    write: true,
    destructive: true,
    domain: (a) => a.name,
    run: ({ id, name, domain, port }, { panel }) =>
      panel.call("/site?action=DelDomain", { id, webname: name, domain, port }),
  });

  tool("aapanel_list_site_backups", {
    title: "List site backups",
    description: "Lists the backups of a website.",
    input: { id: siteId, page, limit },
    run: ({ id, page, limit }, { panel }) => getData(panel, "backup", { search: id, type: 0, p: page, limit }),
  });

  tool("aapanel_backup_site", {
    title: "Back up website",
    description: "Creates a compressed backup of a website's files.",
    input: { id: siteId },
    write: true,
    run: ({ id }, { panel }) => panel.call("/site?action=ToBackup", { id }),
  });

  // ---------------------------------------------------------------- SSL

  tool("aapanel_get_site_ssl", {
    title: "Get site SSL",
    description:
      "Returns the SSL certificate status and configuration of a website. The private key is redacted unless include_private_key is true.",
    input: {
      name: siteName,
      include_private_key: z.boolean().default(false),
    },
    domain: (a) => a.name,
    run: async ({ name, include_private_key }, { panel }) => {
      const ssl = (await panel.call("/site?action=GetSSL", { siteName: name })) as Record<string, unknown>;
      if (!include_private_key && typeof ssl?.key === "string" && ssl.key) {
        ssl.key = `[redacted, ${ssl.key.length} chars]`;
      }
      return ssl;
    },
  });

  tool("aapanel_set_site_ssl", {
    title: "Install SSL certificate",
    description: "Installs a custom SSL certificate (PEM key and certificate chain) on a website.",
    input: {
      name: siteName,
      key: z.string().describe("Private key (PEM)"),
      certificate: z.string().describe("Certificate + chain (PEM)"),
    },
    write: true,
    domain: (a) => a.name,
    run: ({ name, key, certificate }, { panel }) =>
      panel.call("/site?action=SetSSL", { type: 1, siteName: name, key, csr: certificate }),
  });

  tool("aapanel_set_force_https", {
    title: "Force HTTPS",
    description: "Enables or disables the HTTP to HTTPS redirect of a website.",
    input: { name: siteName, enabled: z.boolean() },
    write: true,
    domain: (a) => a.name,
    run: ({ name, enabled }, { panel }) =>
      panel.call(`/site?action=${enabled ? "HttpToHttps" : "CloseToHttps"}`, { siteName: name }),
  });

  // ---------------------------------------------------------------- Files

  tool("aapanel_list_dir", {
    title: "List directory",
    description: "Lists files and folders in a server directory.",
    input: {
      path: z.string().describe("Absolute path, e.g. /www/wwwroot/example.com"),
      page,
      limit: z.number().int().min(1).max(1000).default(100),
    },
    run: ({ path, page, limit }, { panel }) =>
      panel.call("/files?action=GetDir", { path, p: page, showRow: limit }),
  });

  tool("aapanel_read_file", {
    title: "Read file",
    description:
      "Reads a text file from the server. Useful paths: /www/server/panel/vhost/nginx/<site>.conf, /www/server/panel/vhost/rewrite/<site>.conf, /www/wwwlogs/<site>.log, /www/wwwlogs/<site>.error.log.",
    input: { path: z.string().describe("Absolute file path") },
    run: ({ path }, { panel }) => panel.call("/files?action=GetFileBody", { path }),
  });

  tool("aapanel_write_file", {
    title: "Write file",
    description:
      "Writes (overwrites) a text file on the server, creating it if it does not exist. After editing web server config, reload it with aapanel_service_admin.",
    input: {
      path: z.string().describe("Absolute file path"),
      content: z.string(),
      encoding: z.string().default("utf-8"),
    },
    write: true,
    run: async ({ path, content, encoding }, { panel }) => {
      // SaveFileBody refuses to write files that don't exist yet; CreateFile fails harmlessly if it does.
      await panel.call("/files?action=CreateFile", { path });
      return panel.call("/files?action=SaveFileBody", { path, data: content, encoding });
    },
  });

  tool("aapanel_create_dir", {
    title: "Create directory",
    description: "Creates a directory on the server.",
    input: { path: z.string().describe("Absolute directory path") },
    write: true,
    run: ({ path }, { panel }) => panel.call("/files?action=CreateDir", { path }),
  });

  tool("aapanel_delete_path", {
    title: "Delete file or directory",
    description: "Deletes a file or a directory (recursively) from the server.",
    input: {
      path: z.string().describe("Absolute path"),
      is_dir: z.boolean().describe("true if the path is a directory"),
    },
    write: true,
    destructive: true,
    run: ({ path, is_dir }, { panel }) =>
      panel.call(`/files?action=${is_dir ? "DeleteDir" : "DeleteFile"}`, { path }),
  });

  // ---------------------------------------------------------------- Databases

  tool("aapanel_list_databases", {
    title: "List databases",
    description: "Lists the MySQL databases managed by the panel.",
    input: { search: z.string().optional(), page, limit },
    run: ({ search, page, limit }, { panel }) =>
      getData(panel, "databases", { p: page, limit, order: "id desc", search }),
  });

  tool("aapanel_create_database", {
    title: "Create database",
    description: "Creates a MySQL database with its own user.",
    input: {
      name: z.string().describe("Database name"),
      username: z.string().describe("Database user"),
      password: z.string(),
      access: z
        .string()
        .default("127.0.0.1")
        .describe("Allowed host: 127.0.0.1 (local), % (any), or a specific IP"),
      charset: z.string().default("utf8mb4"),
      remark: z.string().optional(),
    },
    write: true,
    run: (a, { panel }) =>
      panel.call("/database?action=AddDatabase", {
        name: a.name,
        db_user: a.username,
        password: a.password,
        dataAccess: a.access,
        address: a.access,
        codeing: a.charset,
        ps: a.remark ?? a.name,
        dtype: "MySQL",
        sid: 0,
      }),
  });

  tool("aapanel_delete_database", {
    title: "Delete database",
    description: "Deletes a MySQL database and its user.",
    input: {
      id: z.number().int().describe("Database ID (from aapanel_list_databases)"),
      name: z.string().describe("Database name"),
    },
    write: true,
    destructive: true,
    run: ({ id, name }, { panel }) => panel.call("/database?action=DeleteDatabase", { id, name }),
  });

  // ---------------------------------------------------------------- FTP

  tool("aapanel_list_ftp", {
    title: "List FTP accounts",
    description: "Lists the FTP accounts managed by the panel.",
    input: { search: z.string().optional(), page, limit },
    run: ({ search, page, limit }, { panel }) => getData(panel, "ftps", { p: page, limit, order: "id desc", search }),
  });

  // ---------------------------------------------------------------- Cron

  tool("aapanel_list_crontab", {
    title: "List cron jobs",
    description: "Lists the scheduled tasks (cron jobs) configured in the panel.",
    input: {},
    run: (_, { panel }) => panel.call("/crontab?action=GetCrontab"),
  });

  tool("aapanel_add_crontab", {
    title: "Add cron job",
    description:
      "Adds a shell-script scheduled task. Schedule types: day (daily at hour:minute), day-n (every N days), hour (hourly at :minute), hour-n (every N hours), minute-n (every N minutes), week (weekly on `week` day 0-6), month (monthly on day N).",
    input: {
      name: z.string().describe("Task name"),
      script: z.string().describe("Shell script body"),
      schedule: z.enum(["day", "day-n", "hour", "hour-n", "minute-n", "week", "month"]),
      every: z
        .number()
        .int()
        .optional()
        .describe("N for day-n/hour-n/minute-n, or day of month for 'month'"),
      hour: z.number().int().min(0).max(23).default(0),
      minute: z.number().int().min(0).max(59).default(0),
      week: z.number().int().min(0).max(6).optional().describe("Day of week for 'week' (0=Sunday)"),
    },
    write: true,
    run: (a, { panel }) =>
      panel.call("/crontab?action=AddCrontab", {
        name: a.name,
        type: a.schedule,
        where1: a.every ?? "",
        hour: a.hour,
        minute: a.minute,
        week: a.week ?? "",
        sType: "toShell",
        sBody: a.script,
        sName: "",
        backupTo: "localhost",
        save: "",
        urladdress: "",
      }),
  });

  tool("aapanel_run_crontab", {
    title: "Run cron job now",
    description: "Executes a scheduled task immediately.",
    input: { id: z.number().int().describe("Task ID (from aapanel_list_crontab)") },
    write: true,
    run: ({ id }, { panel }) => panel.call("/crontab?action=StartTask", { id }),
  });

  tool("aapanel_delete_crontab", {
    title: "Delete cron job",
    description: "Deletes a scheduled task.",
    input: { id: z.number().int().describe("Task ID (from aapanel_list_crontab)") },
    write: true,
    destructive: true,
    run: ({ id }, { panel }) => panel.call("/crontab?action=DelCrontab", { id }),
  });

  // ---------------------------------------------------------------- SSH

  tool("vps_ssh_exec", {
    title: "Run shell command on the VPS",
    description:
      "Runs a shell command on the target's VPS over SSH and returns stdout, stderr and exit code. Commands run with the configured SSH user's privileges, so prefer read-only commands unless a change was requested.",
    input: {
      command: z.string().describe("Shell command, e.g. 'df -h' or 'du -sh /var/log/*'"),
      timeout_seconds: z.number().int().min(1).max(1800).default(120),
    },
    uses: "ssh",
    write: true,
    destructive: true,
    run: ({ command, timeout_seconds }, { ssh }) => ssh.exec(command, timeout_seconds * 1000),
  });

  // ---------------------------------------------------------------- Generic

  tool("aapanel_api_call", {
    title: "Raw aaPanel API call",
    description:
      "Calls any aaPanel API endpoint directly, for operations not covered by the other tools. Authentication is added automatically. Endpoints follow the pattern /<module>?action=<Action>, e.g. /system?action=GetSystemTotal, /firewall?action=GetList, /site?action=GetIndex. Params are sent as form fields; pass nested data as JSON strings.",
    input: {
      path: z.string().describe("Endpoint with action, e.g. /site?action=GetIndex"),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .default({})
        .describe("Form fields to send"),
    },
    write: true,
    destructive: true,
    run: ({ path, params }, { panel }) => panel.call(path, params),
  });
}
