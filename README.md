# mcp-aapanel

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for managing one or more servers that run [aaPanel](https://www.aapanel.com), through the panel's API, plus the underlying VPS over SSH. It lets AI agents and any MCP-compatible client (Cursor, Claude Desktop, VS Code, custom agents, etc.) manage websites, domains, SSL, files, databases, FTP, cron jobs and services, and reach any other panel endpoint through a generic call.

- Runs locally over **stdio**; nothing is installed on your servers.
- **Guided setup:** one command asks for each server's panel URL, API key and SSH login, tests them, and saves them to a private file. No config files to write by hand.
- **Multi-server:** define several *targets* and the server routes each call to the right one, often automatically from the domain involved.
- **Read-only mode** per target, so an agent can inspect production without being able to change it.
- Optional **SSH host-key pinning** (the wizard can pin the key for you) and private-key redaction for SSL output.

## Quick start

```bash
npx -y github:CristhianBuiza/mcp-aapanel setup
```

Answer the questions, paste the printed snippet into your MCP client config, and reload the client. Details below.

---

## Table of contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Enable the aaPanel API](#1-enable-the-aapanel-api)
4. [Install](#2-install)
5. [Run the setup wizard](#3-run-the-setup-wizard)
6. [Connect it to an MCP client](#4-connect-it-to-an-mcp-client)
7. [Advanced configuration](#advanced-configuration)
   - [The targets file](#the-targets-file)
   - [Single server from environment variables](#single-server-from-environment-variables)
   - [How a target is chosen](#how-a-target-is-chosen)
8. [Tools reference](#tools-reference)
9. [Usage examples](#usage-examples)
10. [How it works](#how-it-works)
11. [Security notes](#security-notes)
12. [Troubleshooting](#troubleshooting)
13. [Development](#development)

---

## Features

| Area | What you can do |
| --- | --- |
| Targets | List configured servers, find which server hosts a domain, pin domains to servers |
| System | System, disk and network stats; start/stop/restart/reload services; list App Store software; read panel logs |
| Websites | List, create (optionally with FTP and MySQL), delete, start/stop, change PHP version, manage bound domains, list and create backups |
| SSL | Read SSL status (private key redacted by default), install a custom certificate, toggle forced HTTPS |
| Files | List directories, read, write, create and delete files and folders |
| Databases / FTP | List, create and delete MySQL databases; list FTP accounts |
| Cron | List, add, run now and delete scheduled shell tasks |
| SSH | Run shell commands on the VPS |
| Generic | Call any aaPanel API endpoint not covered by a dedicated tool |

## Requirements

- **Node.js 21.7 or newer** (uses the built-in `process.loadEnvFile`).
- One or more servers with **aaPanel** installed and its **API interface** enabled.
- The public IP of the machine running this MCP server must be in each panel's API **IP whitelist**.
- Optional: SSH access to each VPS (password or private key).

---

## 1. Enable the aaPanel API

aaPanel's API authenticates with an **API key**, not with your panel username and password. On each panel:

1. Open **Settings > API interface** and enable it.
2. Copy the **interface key** (this is your API key).
3. Add the public IP of the machine that will run this server to the **IP whitelist**. You can find it with:

   ```bash
   curl https://api.ipify.org
   ```

4. Note the panel URL, for example `https://YOUR_SERVER_IP:7800`. If you paste the address you use in the browser, the wizard strips the "security entry" path automatically.

## 2. Install

`npm install` installs the dependencies **and** compiles the TypeScript (via the `prepare` script), so a single command is enough.

### Option A: no clone, run with `npx`

Nothing to install up front. `npx` fetches, builds and caches the server from GitHub the first time it runs. Go straight to the setup wizard:

```bash
npx -y github:CristhianBuiza/mcp-aapanel setup
```

### Option B: clone

```bash
git clone https://github.com/CristhianBuiza/mcp-aapanel.git && cd mcp-aapanel && npm install
npm run setup
```

Optionally run `npm test` for an end-to-end test against simulated panels (no real server needed). The compiled entry point is `dist/index.js`.

## 3. Run the setup wizard

MCP servers talk to the client over stdin/stdout, so they cannot stop and ask you questions while running. Instead, a one-time **setup command** asks for each value in your terminal, tests it, and saves it:

```bash
npx -y github:CristhianBuiza/mcp-aapanel setup   # option A
npm run setup                                   # option B, inside the clone
```

For each server it asks, one question at a time (press Enter to accept the value in brackets):

| Question | Notes |
| --- | --- |
| Server name | Defaults to `vps-1`, `vps-2`, ... |
| Description | Optional |
| Panel URL | Enter nothing for an SSH-only VPS |
| API key | Typed input is hidden |
| Verify the TLS certificate? | Answer `n` for aaPanel's default self-signed certificate |
| Test the panel connection? | Calls the panel; if it fails you can correct the values or keep them |
| Set up SSH access? | Optional |
| SSH host / port / user | Host defaults to the panel's host, port `22`, user `root` |
| Private key path, or password | Press Enter on the key path to use a password (hidden) instead |
| Test the SSH connection? | Runs `echo ok`; on success it offers to **pin the server's host key** |
| Read-only? | The agent can inspect but not change this server |
| Domains hosted here | Comma-separated; used to route calls automatically |
| Add another server? | Repeat for as many servers as you have, then pick the default one |

Example session (placeholders only):

```text
$ npx -y github:CristhianBuiza/mcp-aapanel setup
aaPanel MCP setup

Your answers are saved to ~/.config/mcp-aapanel/targets.json (readable only by you).
aaPanel's API uses an API key, not your panel username and password.
In the panel, open Settings > API interface: enable it, copy the key,
and add this machine's public IP to the whitelist.

--- Server 1 ---
Server name [vps-1]:
Description (optional): Main server
Panel URL, e.g. https://203.0.113.10:7800 (Enter = no panel, SSH only): https://203.0.113.10:7800
API key (hidden):
Verify the TLS certificate? Answer n for aaPanel's default self-signed certificate (y/N):
Test the panel connection now? (Y/n):
Panel connected.
Set up SSH access to this VPS? (y/N): y
SSH host [203.0.113.10]:
SSH port [22]:
SSH user [root]:
Private key path (Enter = use a password): ~/.ssh/id_ed25519
Test the SSH connection now? (Y/n):
SSH connected.
Pin the server's host key SHA256:YOUR_HOST_KEY_FINGERPRINT? (Y/n):
Read-only? The agent can inspect this server but not change it (y/N):
Domains hosted here, comma-separated (optional): example.com, example.net

Add another server? (y/N):

Saved 1 server(s) to ~/.config/mcp-aapanel/targets.json.
```

**Where settings are stored:** `~/.config/mcp-aapanel/targets.json` (or `$XDG_CONFIG_HOME/mcp-aapanel/` on Linux, `%APPDATA%\mcp-aapanel\` on Windows), together with `domain-map.json` for domain assignments. The file is created with permissions `600` and lives **outside the repository**, so it can never be committed. Set `AAPANEL_TARGETS_FILE` to use a different path.

**To add servers later**, run setup again and answer `Y` to "Keep them and add another server?". Answer `n` to start over.

If the server is started before setup, it exits with a message telling you to run the setup command; MCP clients show it in their server logs.

## 4. Connect it to an MCP client

The wizard prints the exact snippet to paste. For **Cursor**, add it to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project), then reload MCP servers.

Option A (`npx`):

```json
{
  "mcpServers": {
    "aapanel-vps": {
      "command": "npx",
      "args": ["-y", "github:CristhianBuiza/mcp-aapanel"]
    }
  }
}
```

Option B (clone), replacing the path with your clone's location:

```json
{
  "mcpServers": {
    "aapanel-vps": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-aapanel/dist/index.js"]
    }
  }
}
```

Claude Desktop, VS Code and other stdio MCP clients use the same shape. No credentials are needed in the client config: the server reads the file saved by setup.

### Quick test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y github:CristhianBuiza/mcp-aapanel
```

Call `targets_list`, then `aapanel_get_system_info` to confirm the connection. On startup the server logs the loaded targets to stderr, e.g. `aapanel-vps: 2 target(s) from /home/you/.config/mcp-aapanel/targets.json: vps-1 (default), vps-2 (read-only)`.

---

## Advanced configuration

The wizard covers most setups. Everything it writes can also be written by hand or supplied through environment variables, for example to keep secrets in your MCP client config.

Configuration is resolved in this order (first match wins):

1. `AAPANEL_TARGETS_FILE`, if set.
2. The file saved by `setup` (`~/.config/mcp-aapanel/targets.json`).
3. `targets.json` next to the package (clone only).
4. A single server built from the `AAPANEL_*` / `VPS_SSH_*` environment variables (client `env` block or `.env`).

### The targets file

The wizard writes this format. You can also copy `targets.example.json` and edit it:

```json
{
  "default": "vps-1",
  "targets": [
    {
      "name": "vps-1",
      "description": "Main server",
      "aapanel": {
        "url": "https://203.0.113.10:7800",
        "apiKey": "env:VPS1_AAPANEL_KEY",
        "verifyTls": false
      },
      "ssh": {
        "user": "root",
        "keyPath": "/path/to/id_ed25519_vps1",
        "hostFingerprint": "SHA256:YOUR_HOST_KEY_FINGERPRINT"
      },
      "domains": ["example.com", "example.net"]
    },
    {
      "name": "vps-2",
      "description": "Production, inspect only",
      "readOnly": true,
      "aapanel": {
        "url": "https://198.51.100.20:8888",
        "apiKey": "env:VPS2_AAPANEL_KEY"
      },
      "ssh": {
        "host": "198.51.100.20",
        "port": 2222,
        "user": "admin",
        "password": "env:VPS2_SSH_PASSWORD"
      },
      "domains": ["other-site.com"]
    },
    {
      "name": "vps-3",
      "description": "Plain VPS without aaPanel (SSH only)",
      "ssh": { "host": "192.0.2.30", "user": "root", "keyPath": "/path/to/id_ed25519" }
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `default` | Target used when none is given and none can be inferred. Defaults to the first target |
| `targets[].name` | Unique name; letters, digits, `.`, `_`, `-` |
| `targets[].description` | Free text shown by `targets_list` |
| `targets[].readOnly` | `true` rejects every tool that modifies this server |
| `targets[].aapanel` | `url`, `apiKey`, `verifyTls` (default `true`), `timeoutMs` (default `60000`). Optional: a target can be SSH-only |
| `targets[].ssh` | `host` (defaults to the panel URL's host), `port` (22), `user` (`root`), `password` **or** `keyPath`, optional `hostFingerprint` |
| `targets[].domains` | Domains hosted on this server. Subdomains match automatically |

**Secret references:** any string value written as `"env:VARIABLE"` is replaced with that environment variable (from the client `env` block or `.env`), so you can keep passwords and keys out of the file. The server refuses to start if a referenced variable is unset. The wizard stores the values you type directly, in a file only you can read; replace them with `env:` references afterwards if you prefer.

Path overrides:

| Variable | Description |
| --- | --- |
| `AAPANEL_TARGETS_FILE` | Path of the targets file (used by both `setup` and the server) |
| `AAPANEL_DOMAIN_MAP_FILE` | Path of `domain-map.json` (runtime domain assignments; defaults to the targets file's folder) |
| `AAPANEL_ENV_FILE` | Path of the `.env` file |

### Single server from environment variables

Without any targets file, the server builds one target from these variables (client `env` block, or `.env` copied from `.env.example` in a clone):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AAPANEL_URL` | Yes* | | Panel URL, e.g. `https://YOUR_SERVER_IP:7800` (no security-entry path) |
| `AAPANEL_API_KEY` | Yes* | | Panel API interface key |
| `AAPANEL_VERIFY_TLS` | No | `true` | Set `false` if the panel uses aaPanel's default self-signed certificate |
| `AAPANEL_READ_ONLY` | No | `false` | `true` hides/rejects every tool that changes the server |
| `AAPANEL_TIMEOUT_MS` | No | `60000` | Per-request timeout in milliseconds |
| `AAPANEL_TARGET_NAME` | No | `default` | Name given to this single target |
| `VPS_SSH_HOST` | No | host of `AAPANEL_URL` | SSH host |
| `VPS_SSH_PORT` | No | `22` | SSH port |
| `VPS_SSH_USER` | No | `root` | SSH user |
| `VPS_SSH_KEY` | No | | Path to a private key file |
| `VPS_SSH_PASSWORD` | No | | SSH password (use a key when possible) |
| `VPS_SSH_HOST_FINGERPRINT` | No | | Expected host key, `SHA256:...`. Connections to any other key are refused |

\* At least the panel (`AAPANEL_URL` + `AAPANEL_API_KEY`) or SSH (`VPS_SSH_KEY` or `VPS_SSH_PASSWORD`) must be configured. If neither SSH secret is set, the SSH tool is not registered.

Example client config (placeholders only):

```json
{
  "mcpServers": {
    "aapanel-vps": {
      "command": "npx",
      "args": ["-y", "github:CristhianBuiza/mcp-aapanel"],
      "env": {
        "AAPANEL_URL": "https://YOUR_SERVER_IP:7800",
        "AAPANEL_API_KEY": "YOUR_API_KEY",
        "AAPANEL_VERIFY_TLS": "false",
        "AAPANEL_READ_ONLY": "true"
      }
    }
  }
}
```

To get a host fingerprint by hand: `ssh-keyscan YOUR_SERVER_IP | ssh-keygen -lf -`. Avoid committing a client config that contains real keys.

### How a target is chosen

Every tool (except the `targets_*` helpers) accepts an optional `target` argument. When it is omitted:

1. If the call is about a domain (for example a site `name`), the server looks for it in assignments made with `targets_assign_domain`, then in each target's `domains` list. The longest matching domain wins, so `shop.example.com` can live on a different server than `example.com`.
2. Otherwise it searches each panel's website list for the domain (cached for 5 minutes).
3. If nothing matches, the `default` target is used. If the domain exists on several servers, the call fails and asks for an explicit `target`.

Every response starts with `[target: NAME — reason]` so you always know where a command ran.

---

## Tools reference

Legend: **R** = read-only, **W** = modifies the server, **D** = destructive. Write tools are rejected on read-only targets, and are not registered at all if no target can use them.

### Targets (local, never touch a server)

| Tool | Type | Description |
| --- | --- | --- |
| `targets_list` | R | Configured targets with panel URL, SSH endpoint and domains. No secrets are returned |
| `targets_find_domain` | R | Which target a domain resolves to, and which panels list it as a site |
| `targets_assign_domain` | Local | Pin a domain (and its subdomains) to a target; saved in `domain-map.json` |
| `targets_unassign_domain` | Local | Remove such a pin |

### System

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_get_system_info` | R | OS, panel version, CPU, memory, load, disks and network |
| `aapanel_service_admin` | W | `start` / `stop` / `restart` / `reload` a service such as `nginx`, `mysqld`, `redis`, `php-fpm-82` |
| `aapanel_list_software` | R | App Store software and plugins with install status |
| `aapanel_get_panel_logs` | R | Panel operation log |

### Websites

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_list_sites` | R | Sites with ID, name, path, status, PHP version |
| `aapanel_get_php_versions` | R | Installed PHP versions |
| `aapanel_create_site` | W | Create a site (domain, aliases, path, PHP version, port), optionally with an FTP account and a MySQL database |
| `aapanel_delete_site` | W D | Delete a site; optionally its FTP account, database and files |
| `aapanel_set_site_status` | W | Start or stop a site |
| `aapanel_set_site_php` | W | Change a site's PHP version |
| `aapanel_list_site_domains` | R | Domains bound to a site |
| `aapanel_add_site_domain` | W | Bind domains to a site |
| `aapanel_delete_site_domain` | W D | Unbind a domain |
| `aapanel_list_site_backups` | R | Site backups |
| `aapanel_backup_site` | W | Create a site backup |

### SSL

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_get_site_ssl` | R | Certificate status and config. The private key is redacted unless `include_private_key` is `true` |
| `aapanel_set_site_ssl` | W | Install a custom certificate (PEM key + chain) |
| `aapanel_set_force_https` | W | Enable or disable the HTTP to HTTPS redirect |

### Files

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_list_dir` | R | List a directory |
| `aapanel_read_file` | R | Read a text file (e.g. vhost configs under `/www/server/panel/vhost/`, logs under `/www/wwwlogs/`) |
| `aapanel_write_file` | W | Create or overwrite a text file |
| `aapanel_create_dir` | W | Create a directory |
| `aapanel_delete_path` | W D | Delete a file or a directory (recursively) |

### Databases and FTP

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_list_databases` | R | MySQL databases |
| `aapanel_create_database` | W | Create a database and user; `access` can be `127.0.0.1`, `%` or a specific IP |
| `aapanel_delete_database` | W D | Delete a database and its user |
| `aapanel_list_ftp` | R | FTP accounts |

### Cron

| Tool | Type | Description |
| --- | --- | --- |
| `aapanel_list_crontab` | R | Scheduled tasks |
| `aapanel_add_crontab` | W | Add a shell task. Schedules: `day`, `day-n`, `hour`, `hour-n`, `minute-n`, `week`, `month` |
| `aapanel_run_crontab` | W | Run a task now |
| `aapanel_delete_crontab` | W D | Delete a task |

### SSH and generic

| Tool | Type | Description |
| --- | --- | --- |
| `vps_ssh_exec` | W D | Run a shell command over SSH (timeout 1-1800 s, default 120). Returns stdout, stderr and exit code |
| `aapanel_api_call` | W D | Call any endpoint, e.g. `/firewall?action=GetList`, with form `params`. Authentication is added automatically |

Tool output is capped at 100,000 characters.

---

## Usage examples

Ask your agent in plain language:

- "Show CPU, memory and disk usage on vps-1."
- "Create a PHP 8.2 site for `example.com` with a MySQL database."
- "Enable forced HTTPS on `example.com`."
- "Show the last 100 lines of the nginx error log for `example.com`." (the agent can use `aapanel_read_file` or `vps_ssh_exec`)
- "Which server hosts `shop.example.net`?"
- "Add a daily cron at 03:00 that runs `/www/backup.sh`."

Example raw tool call:

```json
{
  "name": "aapanel_list_sites",
  "arguments": { "search": "example.com", "target": "vps-1" }
}
```

---

## How it works

- **Authentication.** aaPanel's API expects `request_time` (Unix seconds) and `request_token = md5(request_time + md5(api_key))` on every POST. The client computes these automatically and keeps the session cookies the panel returns.
- **Requests.** Calls are form-encoded POSTs to `/<module>?action=<Action>`. Parameters with empty (`undefined`/`null`) values are omitted, because some aaPanel handlers act on the mere presence of a field.
- **TLS.** With `verifyTls: false` the client accepts the panel's self-signed certificate. When a certificate error occurs, the error message suggests this setting.
- **SSH.** Uses [`ssh2`](https://github.com/mscdex/ssh2). Each command opens a connection, runs, and closes. If `hostFingerprint` is set, the server's host key must match exactly.
- **Domain routing.** See [How a target is chosen](#how-a-target-is-chosen). Domain assignments persist in `domain-map.json`.

## Security notes

- The setup wizard saves to your user config folder with permissions `600`, outside the repository. If you keep `.env`, `targets.json` or `domain-map.json` in a clone instead, they are already in `.gitignore`; commit only `.env.example` and `targets.example.json` with placeholders.
- Prefer SSH keys over passwords, and consider `"env:VARIABLE"` references for secrets.
- The panel API key and SSH credentials give full control of the server. Restrict the panel's IP whitelist and use a dedicated, least-privilege SSH user where possible.
- Set `readOnly: true` (or `AAPANEL_READ_ONLY=true`) for servers the agent should only inspect. This disables `vps_ssh_exec` and `aapanel_api_call` too, since they can change anything.
- Pin `hostFingerprint` to protect SSH against man-in-the-middle attacks.
- Review destructive actions (delete site, delete path, delete database, raw API calls, SSH commands) before approving them in your client.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No servers configured yet` | Run `npx -y github:CristhianBuiza/mcp-aapanel setup` (or `npm run setup` in a clone), then reload the MCP server |
| Setup's panel test fails | Check the URL (host and port), the API key, and that this machine's IP is in the panel's API whitelist |
| `references unset variable X` | A `"env:X"` value in `targets.json` has no matching environment variable |
| `Could not reach aaPanel ... SELF_SIGNED` / certificate errors | Set `AAPANEL_VERIFY_TLS=false` or `verifyTls: false` |
| Panel returns an IP / token error | Add your public IP to the panel's API whitelist; check the API key; make sure the machine's clock is accurate (the token is time-based) |
| 404 or HTML responses | Use only `https://HOST:PORT` as the URL, without the security-entry path |
| `Target "X" is read-only` | The tool modifies the server; use another target or disable `readOnly` |
| `exists on several targets` | Pass `target` explicitly, or pin the domain with `targets_assign_domain` |
| SSH `host key ... does not match` | The server's key changed or the fingerprint is wrong; re-check with `ssh-keyscan` |
| `vps_ssh_exec` missing | No writable target has SSH configured |

## Development

```bash
npm install       # install dependencies and build (runs the prepare script)
npm run build     # recompile TypeScript to dist/ after changes
npm test          # build + end-to-end test against simulated panels (includes the setup wizard)
npm run setup     # guided configuration
npm start         # run the server on stdio
```

Project layout:

```text
.env.example          # single-server settings template (copy to .env)
targets.example.json  # multi-server template (copy to targets.json)
package.json          # scripts: build, prepare (build on install), setup, test, start
src/
  index.ts      # entry point: "setup" command, config resolution, registers tools, starts stdio
  setup.ts      # guided setup wizard (asks, tests panel and SSH, saves targets file)
  prompt.ts     # terminal prompts (hidden input for secrets)
  config.ts     # targets file / environment parsing and validation, env: references, config folder
  targets.ts    # target registry, domain routing, site-list discovery, domain-map.json
  client.ts     # aaPanel API client (signed requests, cookies, TLS options)
  ssh.ts        # SSH command runner with host-key pinning
  tools.ts      # all MCP tool definitions
test/
  e2e.mjs       # end-to-end test with mock panels
```

To add a tool, call the `tool(name, spec)` helper in `src/tools.ts`: set `uses` (`panel`, `ssh` or `none`), mark `write` / `destructive` accurately, and provide `domain` if the call is about a domain so automatic routing works. For one-off endpoints you can also use `aapanel_api_call` without changing code.

Built with [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), [`zod`](https://zod.dev), [`undici`](https://github.com/nodejs/undici) and [`ssh2`](https://github.com/mscdex/ssh2).

## Disclaimer

This is an independent project and is not affiliated with or endorsed by aaPanel. Use it at your own risk; review what your agent is about to do, especially for write and destructive operations.
