// src/lib/richMarkdown.ts
//
// What an assistant reply may render beyond plain Markdown: a short list of
// inline HTML tags models use all the time (a <br> in a table cell, <details>
// to fold long output, <sub>, <kbd>), and images. Raw HTML is otherwise
// dropped; these tags become real elements and still pass through
// rehype-sanitize afterwards, without attributes (an <img> keeps src and alt).

import { defaultSchema } from "rehype-sanitize";
import { defaultUrlTransform } from "react-markdown";

/** An inline image the app can show as it is: a raster data URL, never SVG. */
export const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** Tags turned into elements; everything else in raw HTML is dropped, keeping its text. */
const ALLOWED = new Set(["br", "sub", "sup", "kbd", "ins", "del", "s", "details", "summary", "img"]);
const VOID = new Set(["br", "img"]);
const TAG = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", "#39": "'" };

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function decode(text: string): string {
  return text.replace(/&(#?[a-z0-9]+);/gi, (match, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known !== undefined) return known;
    const code = /^#x([0-9a-f]+)$/i.exec(name)?.[1] ?? /^#(\d+)$/.exec(name)?.[1];
    if (!code) return match;
    const value = Number.parseInt(code, name[1]?.toLowerCase() === "x" ? 16 : 10);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  });
}

function attribute(source: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(source);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value === undefined ? undefined : decode(value);
}

/** Rebuild one parent's children, turning raw HTML among them into elements.
 *  Tags may open in one raw node and close in a later one (H<sub>2</sub>O, or a
 *  <details> block around Markdown), so a stack spans the siblings. */
function rebuild(children: HastNode[]): HastNode[] {
  const root: HastNode = { type: "root", children: [] };
  const stack: HastNode[] = [root];
  const top = (): HastNode => stack[stack.length - 1];
  for (const child of children) {
    if (child.type !== "raw") {
      if (child.children) child.children = rebuild(child.children);
      top().children!.push(child);
      continue;
    }
    const raw = child.value ?? "";
    let last = 0;
    for (const match of raw.matchAll(TAG)) {
      const text = raw.slice(last, match.index);
      if (text) top().children!.push({ type: "text", value: decode(text) });
      last = match.index + match[0].length;
      const closing = match[1] === "/";
      const tag = match[2].toLowerCase();
      if (!ALLOWED.has(tag)) continue;
      if (closing) {
        let at = stack.length - 1;
        while (at > 0 && stack[at].tagName !== tag) at--;
        if (at > 0) stack.length = at;
        continue;
      }
      const properties: Record<string, unknown> = {};
      if (tag === "img") {
        const src = attribute(match[3], "src");
        if (!src) continue;
        properties.src = src;
        const alt = attribute(match[3], "alt");
        if (alt) properties.alt = alt;
      }
      const element: HastNode = { type: "element", tagName: tag, properties, children: [] };
      top().children!.push(element);
      if (!VOID.has(tag) && !match[0].endsWith("/>")) stack.push(element);
    }
    const rest = raw.slice(last);
    if (rest) top().children!.push({ type: "text", value: decode(rest) });
  }
  return root.children!;
}

/** Rehype plugin: the allowed raw HTML tags become elements. */
export function rehypeAllowedHtml() {
  return (tree: HastNode): void => {
    if (tree.children) tree.children = rebuild(tree.children);
  };
}

/** The default sanitize schema, plus data: image sources (checked again by
 *  urlTransform and the image component, which only show raster images). */
export const sanitizeSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] },
};

/** react-markdown's URL filter, letting raster data images through. */
export function richUrlTransform(url: string, key: string, node: { tagName?: string }): string {
  if (key === "src" && node.tagName === "img" && SAFE_DATA_IMAGE.test(url)) return url;
  return defaultUrlTransform(url);
}
