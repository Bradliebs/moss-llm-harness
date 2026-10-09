// electron/backend/moss/tools/regex-worker.ts
//
// Runs a model-supplied regular expression in a worker thread with a deadline.
// JavaScript regular expressions can backtrack for minutes on patterns such as
// (a|aa)+$ or .*.*.*x, and no static check catches every such pattern; in the
// main process that would freeze the app, so the worker is stopped instead.

import { Worker } from "node:worker_threads";

const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const pattern = new RegExp(workerData.source, workerData.flags);
parentPort.on("message", (lines) => {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) hits.push(i);
  parentPort.postMessage(hits);
});`;

export type LineMatches = number[] | "timeout";

export class RegexLineMatcher {
  private readonly worker: Worker;
  /** Time left for matching; walking and reading files does not count. */
  private remainingMs: number;
  private closed = false;

  constructor(source: string, flags: string, budgetMs: number) {
    this.worker = new Worker(SOURCE, { eval: true, workerData: { source, flags } });
    this.worker.unref();
    // An error between searches (such as running out of memory) must not reach the main process unhandled.
    this.worker.on("error", () => this.close());
    this.remainingMs = budgetMs;
  }

  /** Indices of the lines that match, or "timeout" once the search's time is up. */
  match(lines: readonly string[]): Promise<LineMatches> {
    if (this.closed) return Promise.resolve("timeout");
    const remaining = this.remainingMs;
    if (remaining <= 0) {
      this.close();
      return Promise.resolve("timeout");
    }
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.close();
        resolve("timeout");
      }, remaining);
      const onMessage = (hits: number[]): void => {
        cleanup();
        resolve(hits);
      };
      const onError = (error: Error): void => {
        cleanup();
        this.close();
        reject(error);
      };
      const cleanup = (): void => {
        this.remainingMs -= Date.now() - started;
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
      };
      this.worker.on("message", onMessage);
      this.worker.on("error", onError);
      this.worker.postMessage(lines);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.worker.terminate();
  }
}
