import { createHash } from "node:crypto";
import { Agent, fetch, type Dispatcher } from "undici";

export type Params = Record<string, string | number | boolean | undefined | null>;

export interface AaPanelClientOptions {
  baseUrl: string;
  apiKey: string;
  verifyTls: boolean;
  timeoutMs: number;
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");

export class AaPanelError extends Error {}

export class AaPanelClient {
  private readonly baseUrl: string;
  private readonly apiKeyHash: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Dispatcher;
  private readonly cookies = new Map<string, string>();

  constructor(options: AaPanelClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKeyHash = md5(options.apiKey);
    this.timeoutMs = options.timeoutMs;
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: options.verifyTls } });
  }

  /**
   * Calls an aaPanel API endpoint, e.g. `call("/system?action=GetSystemTotal")`.
   * Params with `undefined`/`null` values are omitted, because several aaPanel
   * handlers act on the mere presence of a field (e.g. DeleteSite's `ftp`).
   */
  async call(path: string, params: Params = {}): Promise<unknown> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    const requestTime = Math.floor(Date.now() / 1000);

    const body = new URLSearchParams({
      request_time: String(requestTime),
      request_token: md5(String(requestTime) + this.apiKeyHash),
    });
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: body.toString(),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      const hint =
        cause?.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause.code)
          ? " (the panel uses a self-signed certificate; set AAPANEL_VERIFY_TLS=false)"
          : "";
      throw new AaPanelError(`Could not reach aaPanel at ${url}: ${detail}${hint}`);
    }

    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    const text = await response.text();
    if (!response.ok) {
      throw new AaPanelError(`aaPanel responded HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
