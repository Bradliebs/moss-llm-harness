// electron/backend/moss/models/routed-provider.ts
//
// Cross-provider routing. The turn talks to one ChatProvider whose requests are
// dispatched to routes on different providers: the chat model, a fast model for
// summaries and read-only subagents, and an escalation model that takes over
// after repeated harness rejections. Each route has its own provider, endpoint,
// and credentials, so a local Ollama model can escalate to a cloud model and a
// cloud model can hand summaries down to a local one.

import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import type { ModelResolver } from "../task/mission-budget";

export interface ProviderRoute {
  key: string;
  provider: ChatProvider;
  model: string;
  providerKind: string;
  endpoint: string;
  /** runs on this machine, so no workspace context leaves it */
  local: boolean;
  /** served through the constrained step protocol */
  constrained?: boolean;
}

export const ROUTE_PREFIX = "route:";

export function routeToken(key: string): string {
  return `${ROUTE_PREFIX}${key}`;
}

export { isLocalRoute, routeDestination, routeHost } from "../../../../common/routes";

export class RoutedProvider implements ChatProvider {
  readonly kind: string;
  private escalated?: ProviderRoute;

  constructor(private readonly primary: ProviderRoute, private readonly routes: ReadonlyMap<string, ProviderRoute> = new Map()) {
    this.kind = primary.provider.kind;
  }

  get escalation(): ProviderRoute | undefined {
    return this.escalated;
  }

  route(key: string): ProviderRoute | undefined {
    return this.routes.get(key);
  }

  /** Send later chat-model requests to the named route. Returns it, or undefined
   *  when already escalated or the route is missing. */
  escalate(key: string): ProviderRoute | undefined {
    if (this.escalated) return undefined;
    const target = this.routes.get(key);
    if (!target) return undefined;
    this.escalated = target;
    return target;
  }

  resolveRoute(model: string): ProviderRoute {
    if (model.startsWith(ROUTE_PREFIX)) {
      const route = this.routes.get(model.slice(ROUTE_PREFIX.length));
      if (route) return route;
    }
    if (model === this.primary.model || model === routeToken(this.primary.key)) return this.escalated ?? this.primary;
    return this.primary;
  }

  /** For mission budgets: the model that actually runs and whether it is local. */
  readonly resolveModel: ModelResolver = (model) => {
    const route = this.resolveRoute(model);
    return { model: route.model, local: route.local };
  };

  streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const route = this.resolveRoute(req.model);
    return route.provider.streamChat({ ...req, model: route.model }, signal);
  }

  listModels(): Promise<string[]> {
    return this.primary.provider.listModels();
  }
}
