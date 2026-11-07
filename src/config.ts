import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const targetNamePattern = /^[A-Za-z0-9_.-]+$/;

const name = z
  .string()
  .regex(targetNamePattern, "Target names may only contain letters, digits, '.', '_' and '-'");

const TargetSchema = z.object({
  name,
  description: z.string().optional(),
  /** Rejects write tools for this target. */
  readOnly: z.boolean().default(false),
  aapanel: z
    .object({
      url: z.string().url(),
      apiKey: z.string().min(1),
      verifyTls: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .optional(),
  ssh: z
    .object({
      /** Defaults to the hostname of the aaPanel URL. */
      host: z.string().optional(),
      port: z.number().int().default(22),
      user: z.string().default("root"),
      password: z.string().optional(),
      keyPath: z.string().optional(),
      hostFingerprint: z.string().optional(),
    })
    .refine((s) => s.password || s.keyPath, "ssh needs either password or keyPath")
    .optional(),
  /** Domains hosted on this target; subdomains match too. */
  domains: z.array(z.string()).default([]),
});

const FileSchema = z.object({
  default: z.string().optional(),
  targets: z.array(TargetSchema).min(1),
});

export type TargetConfig = z.infer<typeof TargetSchema>;
export type TargetsFile = z.input<typeof FileSchema>;

export function userConfigDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".config"));
  return join(base, "mcp-aapanel");
}

export interface LoadedConfig {
  targets: TargetConfig[];
  defaultName: string;
  source: string;
}

const isTrue = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? "");

/** Replaces "env:VAR" string values with the content of that environment variable. */
function resolveEnvRefs<T>(value: T, path = "targets"): T {
  if (typeof value === "string" && value.startsWith("env:")) {
    const variable = value.slice(4);
    const resolved = process.env[variable];
    if (resolved === undefined) throw new Error(`${path} references unset variable ${variable}`);
    return resolved as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnvRefs(v, `${path}[${i}]`)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v, `${path}.${k}`)]),
    ) as T;
  }
  return value;
}

function fromTargetsFile(file: string): LoadedConfig {
  const raw = resolveEnvRefs(JSON.parse(readFileSync(file, "utf8")));
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${file}: ${z.prettifyError(parsed.error)}`);
  }
  const { targets } = parsed.data;
  const names = targets.map((t) => t.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Invalid ${file}: duplicate target name "${duplicate}"`);

  const defaultName = parsed.data.default ?? targets[0].name;
  if (!names.includes(defaultName)) {
    throw new Error(`Invalid ${file}: default target "${defaultName}" is not defined`);
  }
  return { targets, defaultName, source: file };
}

/** Single target built from the AAPANEL_* / VPS_SSH_* variables (the original setup). */
function fromEnvironment(): LoadedConfig {
  const env = process.env;
  const targetName = env.AAPANEL_TARGET_NAME || "default";
  const sshSecret = env.VPS_SSH_PASSWORD || env.VPS_SSH_KEY;
  const target = TargetSchema.parse({
    name: targetName,
    readOnly: isTrue(env.AAPANEL_READ_ONLY),
    aapanel:
      env.AAPANEL_URL && env.AAPANEL_API_KEY
        ? {
            url: env.AAPANEL_URL,
            apiKey: env.AAPANEL_API_KEY,
            verifyTls: env.AAPANEL_VERIFY_TLS === undefined || isTrue(env.AAPANEL_VERIFY_TLS),
            timeoutMs: Number(env.AAPANEL_TIMEOUT_MS) || 60_000,
          }
        : undefined,
    ssh: sshSecret
      ? {
          host: env.VPS_SSH_HOST || undefined,
          port: Number(env.VPS_SSH_PORT) || 22,
          user: env.VPS_SSH_USER || "root",
          password: env.VPS_SSH_PASSWORD || undefined,
          keyPath: env.VPS_SSH_KEY || undefined,
          hostFingerprint: env.VPS_SSH_HOST_FINGERPRINT || undefined,
        }
      : undefined,
  });
  if (!target.aapanel && !target.ssh) {
    throw new Error(
      'No servers configured yet. Run "npx -y github:CristhianBuiza/mcp-aapanel setup" (or "npm run setup" in a clone), ' +
        "then reload the MCP server. Alternatively create targets.json or set AAPANEL_URL/AAPANEL_API_KEY (and optionally VPS_SSH_*).",
    );
  }
  return { targets: [target], defaultName: targetName, source: "environment variables" };
}

export function loadConfig(targetsFile: string): LoadedConfig {
  return existsSync(targetsFile) ? fromTargetsFile(targetsFile) : fromEnvironment();
}
