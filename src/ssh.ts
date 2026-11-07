import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type ConnectConfig } from "ssh2";

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  /** OpenSSH-style host key fingerprint, e.g. "SHA256:abc..."; connections to other keys are refused. */
  hostFingerprint?: string;
}

export interface ExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

const fingerprintOf = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

export class SshRunner {
  /** Host key fingerprint presented by the server on the last connection attempt. */
  lastHostFingerprint?: string;

  constructor(readonly options: SshOptions) {}

  exec(command: string, timeoutMs: number): Promise<ExecResult> {
    const { host, port, username, password, privateKeyPath, hostFingerprint } = this.options;
    let presentedFingerprint = "";
    const config: ConnectConfig = {
      host,
      port,
      username,
      password,
      privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer) => {
        presentedFingerprint = fingerprintOf(key);
        this.lastHostFingerprint = presentedFingerprint;
        return !hostFingerprint || presentedFingerprint === hostFingerprint;
      },
    };

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        const mismatch =
          hostFingerprint && presentedFingerprint && presentedFingerprint !== hostFingerprint
            ? ` (host key ${presentedFingerprint} does not match VPS_SSH_HOST_FINGERPRINT)`
            : "";
        reject(new Error(`SSH to ${username}@${host}:${port} failed: ${error.message}${mismatch}`));
      };

      conn
        .on("ready", () => {
          conn.exec(command, (error, stream) => {
            if (error) return fail(error);
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
            stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
            stream.on("close", (code: number | null, signal?: string) => {
              clearTimeout(timer);
              conn.end();
              resolve({ exitCode: code, signal, stdout, stderr });
            });
          });
        })
        .on("error", fail)
        .connect(config);
    });
  }
}
