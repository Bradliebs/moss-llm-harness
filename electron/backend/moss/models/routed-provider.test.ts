import { describe, expect, it } from "vitest";

import type { ChatProvider, ChatRequest } from "../providers/types";
import { isLocalRoute, RoutedProvider, routeDestination, routeToken, type ProviderRoute } from "./routed-provider";

function route(key: string, model: string, endpoint: string, local: boolean): ProviderRoute & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    kind: key === "escalation" ? "anthropic" : "openai-compatible",
    async *streamChat(req) {
      seen.push(req);
      yield { type: "text-delta", text: `${key}:${req.model}` };
    },
    async listModels() { return [`${key}-models`]; },
  };
  return { key, provider, model, providerKind: provider.kind, endpoint, local, seen };
}

async function text(provider: ChatProvider, model: string): Promise<string> {
  let out = "";
  for await (const event of provider.streamChat({ model, messages: [] }, new AbortController().signal)) if (event.type === "text-delta") out += event.text;
  return out;
}

describe("isLocalRoute", () => {
  it("keeps loopback and private endpoints local unless the model is served from the cloud", () => {
    expect(isLocalRoute("http://localhost:11434/v1", "llama3.1:8b")).toBe(true);
    expect(isLocalRoute("http://127.0.0.1:8080", "m")).toBe(true);
    expect(isLocalRoute("http://192.168.1.20:11434/v1", "m")).toBe(true);
    expect(isLocalRoute("http://172.20.0.3:11434/v1", "m")).toBe(true);
    expect(isLocalRoute("http://localhost:11434/v1", "glm-5.3:cloud")).toBe(false);
    expect(isLocalRoute("http://localhost:11434/v1", "gpt-oss:120b-cloud")).toBe(false);
    expect(isLocalRoute("https://api.anthropic.com", "claude")).toBe(false);
    expect(isLocalRoute("http://172.32.0.1", "m")).toBe(false);
    expect(isLocalRoute("not a url", "m")).toBe(false);
  });
});

describe("routeDestination", () => {
  it("names the real destination, including Ollama cloud models behind a local server", () => {
    expect(routeDestination("https://api.anthropic.com", "claude")).toBe("api.anthropic.com");
    expect(routeDestination("http://127.0.0.1:11434/v1", "glm-5.3-flash:cloud")).toBe("Ollama's cloud service (through 127.0.0.1:11434)");
    expect(routeDestination("http://localhost:11434/v1", "llama3.1:8b")).toBe("localhost:11434");
  });
});

describe("RoutedProvider", () => {
  it("dispatches route tokens to their provider and model", async () => {
    const chat = route("chat", "llama", "http://localhost:11434/v1", true);
    const fast = route("fast", "qwen-small", "http://localhost:11434/v1", true);
    const router = new RoutedProvider(chat, new Map([["fast", fast]]));
    expect(await text(router, "llama")).toBe("chat:llama");
    expect(await text(router, routeToken("fast"))).toBe("fast:qwen-small");
    // An unknown route falls back to the chat route rather than failing the turn.
    expect(await text(router, routeToken("missing"))).toBe("chat:llama");
    expect(await router.listModels()).toEqual(["chat-models"]);
  });

  it("sends later chat-model requests to the escalation route, once", async () => {
    const chat = route("chat", "llama", "http://localhost:11434/v1", true);
    const escalation = route("escalation", "claude-sonnet", "https://api.anthropic.com", false);
    const router = new RoutedProvider(chat, new Map([["escalation", escalation]]));
    expect(router.resolveModel("llama")).toEqual({ model: "llama", local: true });
    expect(router.escalate("missing")).toBeUndefined();
    expect(router.escalate("escalation")).toBe(escalation);
    expect(router.escalate("escalation")).toBeUndefined();
    expect(router.escalation).toBe(escalation);
    expect(await text(router, "llama")).toBe("escalation:claude-sonnet");
    expect(escalation.seen[0].model).toBe("claude-sonnet");
    expect(router.resolveModel("llama")).toEqual({ model: "claude-sonnet", local: false });
  });
});
