import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import type { BrowserDriver, BrowserDriverFactory, BrowserTarget } from "./browser-tools";

export interface PlaywrightDriverOptions {
  headless?: boolean;
  allowedDomains?: string[];
}

export function createPlaywrightDriverFactory(options: PlaywrightDriverOptions = {}): BrowserDriverFactory {
  return async () => {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
    const context = await browser.newContext({ acceptDownloads: false });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const allowedDomains = new Set((options.allowedDomains ?? []).map(normalizeDomain).filter(Boolean));
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isNetworkUrlAllowed(url, allowedDomains)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    return new PlaywrightBrowserDriver(browser, context, page);
    } catch (error) {
      await browser.close();
      throw error;
    }
  };
}

class PlaywrightBrowserDriver implements BrowserDriver {
  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async inspect(mode: "accessibility" | "text"): Promise<string> {
    if (mode === "text") return this.page.locator("body").innerText();
    return this.page.locator("body").ariaSnapshot();
  }

  async click(target: BrowserTarget): Promise<void> {
    await this.locator(target).click();
  }

  async type(target: BrowserTarget, text: string, clear: boolean): Promise<void> {
    const locator = this.locator(target);
    if (clear) await locator.fill(text);
    else await locator.pressSequentially(text);
  }

  async screenshot(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await this.page.screenshot({ path, fullPage: true });
  }

  currentUrl(): Promise<string> {
    return Promise.resolve(this.page.url());
  }

  pageText(): Promise<string> {
    return this.page.locator("body").innerText();
  }

  async close(): Promise<void> {
    try {
      await this.context.close({ reason: "Host closed automation session" });
    } finally {
      await this.browser.close({ reason: "Host closed automation session" });
    }
  }

  private locator(target: BrowserTarget): Locator {
    if (target.selector) return this.page.locator(target.selector).first();
    return this.page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      ...(target.name ? { name: target.name, exact: true } : {}),
    }).first();
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

export function isNetworkUrlAllowed(raw: string, allowedDomains: ReadonlySet<string>): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = normalizeDomain(url.hostname);
  for (const domain of allowedDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}