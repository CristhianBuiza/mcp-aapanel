// End-to-end test: starts fake aaPanel instances and drives the built MCP server over stdio.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const md5 = (s) => createHash("md5").update(s).digest("hex");
const serverEntry = new URL("../dist/index.js", import.meta.url).pathname;

function fakePanel(id, key, sites) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      calls.push({ url: req.url, fields: Object.fromEntries(p), cookie: req.headers.cookie });
      res.setHeader("Set-Cookie", `session-${id}=1; Path=/`);
      res.setHeader("Content-Type", "application/json");
      if (p.get("request_token") !== md5(p.get("request_time") + md5(key))) {
        return res.end(JSON.stringify({ status: false, msg: "Secret key verification failed" }));
      }
      if (req.url.startsWith("/data?action=getData&table=sites")) {
        return res.end(JSON.stringify({ data: sites.map((name, i) => ({ id: i + 1, name })) }));
      }
      res.end(JSON.stringify({ status: true, panel: id, url: req.url }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }),
    ),
  );
}

async function connect(env) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { PATH: process.env.PATH, AAPANEL_ENV_FILE: "/nonexistent", AAPANEL_TARGETS_FILE: "/nonexistent", ...env },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    const header = /^\[target: ([^\s]+) — (.*)\]\n/.exec(text);
    const body = header ? text.slice(header[0].length) : text;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }
    return { isError: r.isError, target: header?.[1], reason: header?.[2], data, text };
  };
  return { client, call, tools: (await client.listTools()).tools.map((t) => t.name) };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (error) {
    results.push(["FAIL", name, error.message]);
  }
}

const panel1 = await fakePanel("p1", "key-one", ["a.com", "shared.com"]);
const panel2 = await fakePanel("p2", "key-two", ["c.com", "shared.com"]);
const panel3 = await fakePanel("p3", "key-three", []);
const dir = mkdtempSync(join(tmpdir(), "aapanel-e2e-"));

// --- Single target from environment variables (original setup) ---
{
  const { client, call, tools } = await connect({ AAPANEL_URL: panel1.url, AAPANEL_API_KEY: "key-one" });
  await check("legacy env: tools registered, no SSH tool without credentials", () => {
    assert.ok(tools.includes("aapanel_list_sites"));
    assert.ok(!tools.includes("vps_ssh_exec"));
  });
  await check("legacy env: call reaches the panel as target 'default'", async () => {
    const r = await call("aapanel_list_sites");
    assert.equal(r.isError, false);
    assert.equal(r.target, "default");
    assert.equal(r.data.data[0].name, "a.com");
  });
  await check("legacy env: session cookie is resent", async () => {
    await call("aapanel_get_php_versions");
    assert.ok(panel1.calls.at(-1).cookie?.includes("session-p1=1"));
  });
  await client.close();
}
{
  const { client, call } = await connect({ AAPANEL_URL: panel1.url, AAPANEL_API_KEY: "wrong" });
  await check("wrong API key is reported as an error", async () => {
    const r = await call("aapanel_list_sites");
    assert.equal(r.isError, true);
    assert.match(r.text, /verification failed/);
  });
  await client.close();
}
{
  const { client, tools } = await connect({
    AAPANEL_URL: panel1.url,
    AAPANEL_API_KEY: "key-one",
    AAPANEL_READ_ONLY: "true",
  });
  await check("read-only env: write tools are not registered", () => {
    assert.ok(tools.includes("aapanel_list_sites"));
    assert.ok(!tools.includes("aapanel_delete_site"));
    assert.ok(!tools.includes("aapanel_api_call"));
  });
  await client.close();
}

// --- Multiple targets from targets.json ---
const targetsFile = join(dir, "targets.json");
const mapFile = join(dir, "domain-map.json");
writeFileSync(
  targetsFile,
  JSON.stringify({
    default: "vps-1",
    targets: [
      { name: "vps-1", aapanel: { url: panel1.url, apiKey: "key-one", verifyTls: false }, domains: ["a.com"] },
      {
        name: "vps-2",
        aapanel: { url: panel2.url, apiKey: "env:SECOND_KEY" },
        domains: ["b.com"],
      },
      { name: "vps-ro", readOnly: true, aapanel: { url: panel3.url, apiKey: "key-three" } },
    ],
  }),
);
{
  const env = { AAPANEL_TARGETS_FILE: targetsFile, AAPANEL_DOMAIN_MAP_FILE: mapFile, SECOND_KEY: "key-two" };
  const { client, call, tools } = await connect(env);

  await check("targets_list shows all targets without secrets", async () => {
    const r = await call("targets_list");
    assert.deepEqual(r.data.map((t) => t.name), ["vps-1", "vps-2", "vps-ro"]);
    assert.equal(r.data.find((t) => t.default).name, "vps-1");
    assert.ok(!r.text.includes("key-one") && !r.text.includes("key-two"));
  });
  await check("no target given and no domain: default target", async () => {
    const r = await call("aapanel_list_sites");
    assert.equal(r.target, "vps-1");
    assert.equal(r.data.data[0].name, "a.com");
  });
  await check("explicit target is used (with env: key reference)", async () => {
    const r = await call("aapanel_list_sites", { target: "vps-2" });
    assert.equal(r.isError, false);
    assert.equal(r.target, "vps-2");
    assert.equal(r.data.data[0].name, "c.com");
  });
  await check("subdomain of a configured domain goes to its target", async () => {
    const r = await call("aapanel_get_site_ssl", { name: "shop.b.com" });
    assert.equal(r.target, "vps-2");
    assert.match(r.reason, /targets config/);
    assert.equal(panel2.calls.at(-1).fields.siteName, "shop.b.com");
  });
  await check("unconfigured domain is found in a panel's site list", async () => {
    const r = await call("aapanel_get_site_ssl", { name: "www.c.com" });
    assert.equal(r.target, "vps-2");
    assert.match(r.reason, /found in its aaPanel sites/);
  });
  await check("domain on several panels asks for an explicit target", async () => {
    const r = await call("aapanel_get_site_ssl", { name: "shared.com" });
    assert.equal(r.isError, true);
    assert.match(r.text, /several targets/);
  });
  await check("assigning a domain routes later calls and is saved", async () => {
    const a = await call("targets_assign_domain", { domain: "https://www.new.com/", target: "vps-2" });
    assert.equal(a.isError, false);
    assert.deepEqual(JSON.parse(readFileSync(mapFile, "utf8")), { "new.com": "vps-2" });
    const r = await call("aapanel_create_site", { domain: "new.com" });
    assert.equal(r.target, "vps-2");
    assert.match(r.reason, /domain assignment/);
  });
  await check("assignment overrides config for the same domain", async () => {
    await call("targets_assign_domain", { domain: "a.com", target: "vps-2" });
    assert.equal((await call("aapanel_get_site_ssl", { name: "a.com" })).target, "vps-2");
    await call("targets_unassign_domain", { domain: "a.com" });
    assert.equal((await call("aapanel_get_site_ssl", { name: "a.com" })).target, "vps-1");
  });
  await check("targets_find_domain reports resolution and panel matches", async () => {
    const r = await call("targets_find_domain", { domain: "c.com" });
    assert.equal(r.data.resolvesTo.target, "vps-2");
    assert.deepEqual(r.data.foundInPanels, [{ target: "vps-2", site: "c.com" }]);
  });
  await check("unknown target is rejected", async () => {
    const r = await call("aapanel_list_sites", { target: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Unknown target "nope"/);
  });
  await check("write tool on a read-only target is rejected", async () => {
    const before = panel3.calls.length;
    const r = await call("aapanel_backup_site", { id: 1, target: "vps-ro" });
    assert.equal(r.isError, true);
    assert.match(r.text, /read-only/);
    assert.equal(panel3.calls.length, before);
  });
  await check("SSH tool absent when no target has SSH", () => assert.ok(!tools.includes("vps_ssh_exec")));
  await client.close();
}
{
  const badFile = join(dir, "bad.json");
  writeFileSync(badFile, JSON.stringify({ default: "x", targets: [{ name: "vps-1" }] }));
  await check("invalid default target fails at startup", async () => {
    await assert.rejects(connect({ AAPANEL_TARGETS_FILE: badFile }));
  });
}

// --- Guided setup ---
function runSetup(env, answers) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverEntry, "setup"], { env: { PATH: process.env.PATH, ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(answers.map((a) => `${a}\n`).join(""));
  });
}
{
  const setupFile = join(dir, "setup", "targets.json");
  // name, description, panel URL, API key, test panel, SSH?, read-only, domains, add another
  const run = await runSetup({ AAPANEL_TARGETS_FILE: setupFile }, ["", "", panel1.url, "key-one", "", "", "", "a.com", ""]);
  await check("setup: tests the panel and saves a private targets file", () => {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Panel connected/);
    assert.equal(statSync(setupFile).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(setupFile, "utf8"));
    assert.equal(saved.default, "vps-1");
    assert.deepEqual(saved.targets[0].aapanel, { url: panel1.url, apiKey: "key-one", verifyTls: false });
    assert.deepEqual(saved.targets[0].domains, ["a.com"]);
    assert.ok(!run.out.includes("key-one"), "API key must not be echoed");
  });
  const { client, call } = await connect({ AAPANEL_TARGETS_FILE: setupFile });
  await check("setup: server starts from the saved file", async () => {
    const r = await call("aapanel_list_sites");
    assert.equal(r.isError, false);
    assert.equal(r.target, "vps-1");
  });
  await client.close();
}
{
  const setupFile = join(dir, "setup-retry", "targets.json");
  const answers = ["", "", panel1.url, "wrong", "", "", "", "key-one", "", "", "", "", ""];
  const run = await runSetup({ AAPANEL_TARGETS_FILE: setupFile }, answers);
  await check("setup: a rejected API key is reported and can be corrected", () => {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Panel test failed: .*verification failed/);
    assert.equal(JSON.parse(readFileSync(setupFile, "utf8")).targets[0].aapanel.apiKey, "key-one");
  });
}

panel1.close();
panel2.close();
panel3.close();
for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? `\n      ${detail}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
