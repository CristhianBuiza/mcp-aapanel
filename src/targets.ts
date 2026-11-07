import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AaPanelClient } from "./client.js";
import type { LoadedConfig, TargetConfig } from "./config.js";
import { SshRunner } from "./ssh.js";

export interface Target {
  name: string;
  description?: string;
  readOnly: boolean;
  panel?: AaPanelClient;
  ssh?: SshRunner;
  config: TargetConfig;
}

export interface Resolution {
  target: Target;
  reason: string;
}

const SITE_CACHE_MS = 5 * 60_000;

export const normalizeDomain = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/:].*$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");

const covers = (owned: string, domain: string) => domain === owned || domain.endsWith(`.${owned}`);

export class TargetRegistry {
  private readonly targets = new Map<string, Target>();
  private readonly defaultName: string;
  /** Assignments made at runtime with targets_assign_domain; they take precedence over config. */
  private assignments: Record<string, string> = {};
  private readonly siteCache = new Map<string, { at: number; names: string[] }>();

  constructor(
    config: LoadedConfig,
    private readonly assignmentsFile: string,
  ) {
    for (const t of config.targets) {
      this.targets.set(t.name, {
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        config: t,
        panel: t.aapanel ? new AaPanelClient({ baseUrl: t.aapanel.url, ...t.aapanel }) : undefined,
        ssh: t.ssh
          ? new SshRunner({
              host: t.ssh.host ?? (t.aapanel ? new URL(t.aapanel.url).hostname : ""),
              port: t.ssh.port,
              username: t.ssh.user,
              password: t.ssh.password,
              privateKeyPath: t.ssh.keyPath,
              hostFingerprint: t.ssh.hostFingerprint,
            })
          : undefined,
      });
      if (t.ssh && !t.ssh.host && !t.aapanel) {
        throw new Error(`Target "${t.name}": ssh.host is required when there is no aapanel.url`);
      }
    }
    this.defaultName = config.defaultName;
    if (existsSync(assignmentsFile)) {
      this.assignments = JSON.parse(readFileSync(assignmentsFile, "utf8"));
    }
  }

  all(): Target[] {
    return [...this.targets.values()];
  }

  get defaultTarget(): Target {
    return this.targets.get(this.defaultName)!;
  }

  get(name?: string): Target {
    if (!name) return this.defaultTarget;
    const target = this.targets.get(name);
    if (!target) {
      throw new Error(`Unknown target "${name}". Available: ${[...this.targets.keys()].join(", ")}`);
    }
    return target;
  }

  describe() {
    return this.all().map((t) => ({
      name: t.name,
      default: t.name === this.defaultName,
      description: t.description,
      readOnly: t.readOnly,
      aapanel: t.config.aapanel?.url ?? null,
      ssh: t.ssh ? `${t.ssh.options.username}@${t.ssh.options.host}:${t.ssh.options.port}` : null,
      domains: [
        ...new Set([
          ...t.config.domains.map(normalizeDomain),
          ...Object.entries(this.assignments)
            .filter(([, owner]) => owner === t.name)
            .map(([domain]) => domain),
        ]),
      ],
    }));
  }

  /** Longest configured or assigned domain that covers `domain`. */
  private lookupOwner(domain: string): { name: string; via: string } | undefined {
    const longest = (entries: [string, string][]) =>
      entries.filter(([owned]) => covers(owned, domain)).sort((a, b) => b[0].length - a[0].length)[0];
    const configured = longest(
      this.all().flatMap((t) => t.config.domains.map((d): [string, string] => [normalizeDomain(d), t.name])),
    );
    const assigned = longest(Object.entries(this.assignments));
    if (assigned && (!configured || assigned[0].length >= configured[0].length)) {
      return { name: assigned[1], via: "domain assignment" };
    }
    return configured && { name: configured[1], via: "targets config" };
  }

  private async siteNames(target: Target): Promise<string[]> {
    const cached = this.siteCache.get(target.name);
    if (cached && Date.now() - cached.at < SITE_CACHE_MS) return cached.names;
    const response = (await target.panel!.call("/data?action=getData&table=sites", {
      tojs: "",
      p: 1,
      limit: 1000,
      type: -1,
    })) as { data?: { name: string }[] };
    const names = (response.data ?? []).map((s) => normalizeDomain(s.name));
    this.siteCache.set(target.name, { at: Date.now(), names });
    return names;
  }

  /** Searches every target's aaPanel site list for a site covering `domain`. */
  async discover(domain: string): Promise<{ target: string; site: string }[]> {
    const found: { target: string; site: string }[] = [];
    await Promise.all(
      this.all()
        .filter((t) => t.panel)
        .map(async (t) => {
          try {
            for (const site of await this.siteNames(t)) {
              if (covers(site, domain)) found.push({ target: t.name, site });
            }
          } catch {
            // Unreachable panels are skipped; explicit target selection still works.
          }
        }),
    );
    return found;
  }

  /**
   * Picks the target for a call: explicit name, then the domain's configured or assigned
   * owner, then a site-list lookup across panels, then the default target.
   */
  async resolve(explicit?: string, domain?: string): Promise<Resolution> {
    if (explicit) return { target: this.get(explicit), reason: "selected explicitly" };
    if (domain && this.targets.size > 1) {
      const normalized = normalizeDomain(domain);
      const owner = this.lookupOwner(normalized);
      if (owner) return { target: this.get(owner.name), reason: `${normalized} via ${owner.via}` };

      const matches = await this.discover(normalized);
      const owners = [...new Set(matches.map((m) => m.target))];
      if (owners.length === 1) {
        return { target: this.get(owners[0]), reason: `${normalized} found in its aaPanel sites` };
      }
      if (owners.length > 1) {
        throw new Error(
          `${normalized} exists on several targets (${owners.join(", ")}); pass "target" to choose one.`,
        );
      }
    }
    return { target: this.defaultTarget, reason: "default target" };
  }

  assign(domain: string, targetName: string) {
    this.get(targetName);
    this.assignments[normalizeDomain(domain)] = targetName;
    this.saveAssignments();
  }

  unassign(domain: string): boolean {
    const key = normalizeDomain(domain);
    if (!(key in this.assignments)) return false;
    delete this.assignments[key];
    this.saveAssignments();
    return true;
  }

  private saveAssignments() {
    mkdirSync(dirname(this.assignmentsFile), { recursive: true });
    writeFileSync(this.assignmentsFile, `${JSON.stringify(this.assignments, null, 2)}\n`);
  }
}
