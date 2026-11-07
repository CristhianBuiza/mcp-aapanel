import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface Prompter {
  text(question: string, fallback?: string): Promise<string>;
  secret(question: string, hasSaved?: boolean): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

/**
 * Line-based terminal prompts. Works with a TTY (secrets are not echoed) and with
 * piped input (answers are echoed so transcripts stay readable; secrets as asterisks).
 */
export function createPrompter(): Prompter {
  const tty = Boolean(process.stdin.isTTY);
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  rl.on("SIGINT", () => {
    muted = false;
    process.stdout.write("\nSetup cancelled. Nothing was saved.\n");
    process.exit(130);
  });
  // The async iterator buffers lines, so piped answers are not lost between questions.
  const lines = rl[Symbol.asyncIterator]();

  const read = async () => {
    const { value, done } = await lines.next();
    if (done) throw new Error("Setup cancelled: input closed before all questions were answered.");
    return String(value).trim();
  };

  const prompter: Prompter = {
    async text(question, fallback) {
      rl.setPrompt(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      rl.prompt();
      const answer = await read();
      if (!tty) process.stdout.write(`${answer}\n`);
      return answer || fallback || "";
    },
    async secret(question, hasSaved = false) {
      process.stdout.write(`${question} (hidden)${hasSaved ? " [saved, Enter to keep]" : ""}: `);
      muted = true;
      rl.setPrompt("");
      rl.prompt();
      let answer: string;
      try {
        answer = await read();
      } finally {
        muted = false;
      }
      process.stdout.write(tty ? "\n" : `${answer ? "********" : ""}\n`);
      return answer;
    },
    async confirm(question, fallback) {
      for (;;) {
        const answer = (await prompter.text(`${question} (${fallback ? "Y/n" : "y/N"})`)).toLowerCase();
        if (!answer) return fallback;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
        process.stdout.write("Please answer y or n.\n");
      }
    },
    close: () => rl.close(),
  };
  return prompter;
}
