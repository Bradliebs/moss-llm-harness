// common/routes.ts
//
// Shared by the router and the Settings UI so both agree on which routes keep
// workspace context on this machine.

/** True when the endpoint is on this machine or a private network and the model
 *  is not an Ollama cloud model served through it. */
export function isLocalRoute(baseUrl: string, model: string): boolean {
  if (/[:-]cloud$/i.test(model.trim())) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

/** Host shown in notices, for example "api.anthropic.com". */
export function routeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Where a route sends context, for notices. An Ollama cloud model reached
 *  through a local server still leaves the machine. */
export function routeDestination(baseUrl: string, model: string): string {
  const host = routeHost(baseUrl);
  return /[:-]cloud$/i.test(model.trim()) && isLocalRoute(baseUrl, "") ? `Ollama's cloud service (through ${host})` : host;
}
