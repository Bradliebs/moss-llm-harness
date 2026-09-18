import type { Tool } from "./types";

export function managedTools(tools: Tool[], close: () => Promise<void>): Tool[] {
  let cleanup: Promise<void> | undefined;
  const dispose = () => cleanup ??= close();
  return tools.map((tool) => ({
    ...tool,
    timeoutMs: 30_000,
    dispose,
    async execute(args, ctx) {
      if (ctx.signal.aborted || cleanup) return { ok: false, content: "Automation session cancelled or closed" };
      const onAbort = () => { void dispose().catch(() => undefined); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await tool.execute(args, ctx);
        if (ctx.signal.aborted) return { ok: false, content: "Automation operation aborted" };
        return result;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        if (cleanup) await cleanup;
      }
    },
  }));
}