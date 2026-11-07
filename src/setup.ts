import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { AaPanelClient } from "./client.js";
import { loadConfig, targetNamePattern, type TargetsFile } from "./config.js";
import { createPrompter, type Prompter } from "./prompt.js";
import { SshRunner } from "./ssh.js";

type TargetEntry = TargetsFile["targets"][number];
type PanelEntry = NonNullable<TargetEntry["aapanel"]>;
type SshEntry = NonNullable<TargetEntry["ssh"]>;

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;

function readExisting(file: string): TargetsFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed?.targets) && parsed.targets.length > 0) return parsed;
  } catch {
    console.log(`${file} is not valid JSON; it will be replaced.\n`);
  }
  return undefined;
}

async function askPanel(p: Prompter, current?: PanelEntry): Promise<PanelEntry | undefined> {
  for (;;) {
    const raw = await p.text(
      "Panel URL, e.g. https://203.0.113.10:7800 (Enter = no panel, SSH only)",
      current?.url,
    );
    if (!raw) return undefined;
    let url: URL;
    try {
      url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      console.log("That is not a valid URL.");
      continue;
    }
    if (url.pathname !== "/") {
      console.log(`Using ${url.origin}; the security-entry path is not needed for the API.`);
    }
    let apiKey = "";
    while (!apiKey) {
      apiKey = (await p.secret("API key", Boolean(current?.apiKey))) || current?.apiKey || "";
    }
    const verifyTls =
      url.protocol === "https:" &&
      (await p.confirm(
        "Verify the TLS certificate? Answer n for aaPanel's default self-signed certificate",
        current?.verifyTls ?? false,
      ));
    const panel: PanelEntry = { url: url.origin, apiKey, verifyTls };
    if (apiKey.startsWith("env:") || !(await p.confirm("Test the panel connection now?", true))) return panel;

    try {
      const client = new AaPanelClient({ baseUrl: panel.url, apiKey, verifyTls, timeoutMs: 15_000 });
      const r = await client.call("/system?action=GetSystemTotal");
      if (!r || typeof r !== "object") throw new Error("unexpected response; is this the panel URL?");
      const info = r as Record<string, unknown>;
      if (info.status === false) throw new Error(String(info.msg ?? "the panel rejected the request"));
      const details = [info.system, info.version && `aaPanel ${info.version}`].filter(Boolean).join(", ");
      console.log(`Panel connected${details ? ` (${details})` : ""}.`);
      return panel;
    } catch (error) {
      console.log(`Panel test failed: ${(error as Error).message}`);
      console.log("Check the URL, the API key, and that this machine's IP is in the panel's API whitelist.");
      if (await p.confirm("Keep these panel settings anyway?", false)) return panel;
      current = panel;
    }
  }
}

async function askSsh(p: Prompter, defaultHost?: string, current?: SshEntry): Promise<SshEntry | undefined> {
  if (!(await p.confirm("Set up SSH access to this VPS?", Boolean(current)))) return undefined;
  for (;;) {
    let host = "";
    while (!host) host = await p.text("SSH host", current?.host ?? defaultHost);
    const port = Number(await p.text("SSH port", String(current?.port ?? 22))) || 22;
    const user = await p.text("SSH user", current?.user ?? "root");

    let keyPath = "";
    for (;;) {
      keyPath = await p.text("Private key path (Enter = use a password)", current?.keyPath);
      if (!keyPath) break;
      keyPath = resolve(expandHome(keyPath));
      if (existsSync(keyPath)) break;
      console.log(`No file at ${keyPath}.`);
    }
    let password = "";
    while (!keyPath && !password) {
      password = (await p.secret("SSH password", Boolean(current?.password))) || current?.password || "";
    }
    const ssh: SshEntry = {
      host,
      port,
      user,
      ...(keyPath ? { keyPath } : { password }),
      ...(current?.hostFingerprint && { hostFingerprint: current.hostFingerprint }),
    };
    if (password.startsWith("env:") || !(await p.confirm("Test the SSH connection now?", true))) return ssh;

    const runner = new SshRunner({
      host,
      port,
      username: user,
      password: password || undefined,
      privateKeyPath: keyPath || undefined,
      hostFingerprint: ssh.hostFingerprint,
    });
    try {
      const r = await runner.exec("echo ok", 20_000);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit code ${r.exitCode}`);
      console.log("SSH connected.");
      const presented = runner.lastHostFingerprint;
      if (!ssh.hostFingerprint && presented && (await p.confirm(`Pin the server's host key ${presented}?`, true))) {
        ssh.hostFingerprint = presented;
      }
      return ssh;
    } catch (error) {
      console.log(`SSH test failed: ${(error as Error).message}`);
      if (await p.confirm("Keep these SSH settings anyway?", false)) return ssh;
      current = ssh;
    }
  }
}

async function askTarget(p: Prompter, index: number, usedNames: Set<string>): Promise<TargetEntry> {
  let name = "";
  for (;;) {
    name = await p.text("Server name", `vps-${index}`);
    if (!targetNamePattern.test(name)) console.log("Use only letters, digits, '.', '_' and '-'.");
    else if (usedNames.has(name)) console.log(`"${name}" is already used.`);
    else break;
  }
  const description = await p.text("Description (optional)");

  let aapanel: PanelEntry | undefined;
  let ssh: SshEntry | undefined;
  for (;;) {
    aapanel = await askPanel(p);
    ssh = await askSsh(p, aapanel && new URL(aapanel.url).hostname);
    if (aapanel || ssh) break;
    console.log("A server needs a panel URL, SSH access, or both.\n");
  }
  const readOnly = await p.confirm("Read-only? The agent can inspect this server but not change it", false);
  const domains = (await p.text("Domains hosted here, comma-separated (optional)"))
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  return {
    name,
    ...(description && { description }),
    readOnly,
    ...(aapanel && { aapanel }),
    ...(ssh && { ssh }),
    domains,
  };
}

function clientConfigSnippet(file: string): string {
  const entry = realpathSync(process.argv[1]);
  const server: Record<string, unknown> = entry.includes(`${sep}_npx${sep}`)
    ? { command: "npx", args: ["-y", "github:CristhianBuiza/mcp-aapanel"] }
    : { command: "node", args: [entry] };
  if (process.env.AAPANEL_TARGETS_FILE) server.env = { AAPANEL_TARGETS_FILE: file };
  return JSON.stringify({ mcpServers: { "aapanel-vps": server } }, null, 2);
}

/** Interactive first-run setup that writes a targets file. Returns the process exit code. */
export async function runSetup(file: string): Promise<number> {
  const p = createPrompter();
  try {
    console.log("aaPanel MCP setup\n");
    console.log(`Your answers are saved to ${file} (readable only by you).`);
    console.log("aaPanel's API uses an API key, not your panel username and password.");
    console.log("In the panel, open Settings > API interface: enable it, copy the key,");
    console.log("and add this machine's public IP to the whitelist.\n");

    const existing = readExisting(file);
    let targets: TargetEntry[] = [];
    let defaultName: string | undefined;
    if (existing) {
      console.log(`Found ${existing.targets.length} server(s): ${existing.targets.map((t) => t.name).join(", ")}.`);
      if (await p.confirm("Keep them and add another server?", true)) {
        targets = [...existing.targets];
        defaultName = existing.default;
      } else if (!(await p.confirm(`Start over and replace ${file}?`, false))) {
        console.log("Nothing changed.");
        return 0;
      }
    }

    do {
      console.log(`\n--- Server ${targets.length + 1} ---`);
      targets.push(await askTarget(p, targets.length + 1, new Set(targets.map((t) => t.name))));
    } while (await p.confirm("\nAdd another server?", false));

    const names = targets.map((t) => t.name);
    if (names.length === 1) {
      defaultName = names[0];
    } else {
      for (;;) {
        const fallback = defaultName && names.includes(defaultName) ? defaultName : names[0];
        defaultName = await p.text(`Default server (${names.join(", ")})`, fallback);
        if (names.includes(defaultName)) break;
        console.log("Pick one of the names above.");
      }
    }

    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ default: defaultName, targets }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`\nSaved ${names.length} server(s) to ${file}.`);
    try {
      loadConfig(file);
    } catch (error) {
      console.log(`Warning: the server will not start with this file yet: ${(error as Error).message}`);
    }

    console.log("\nAdd the server to your MCP client (for Cursor: ~/.cursor/mcp.json), then reload it:\n");
    console.log(clientConfigSnippet(file));
    return 0;
  } catch (error) {
    console.error(`\n${(error as Error).message}`);
    return 1;
  } finally {
    p.close();
  }
}
