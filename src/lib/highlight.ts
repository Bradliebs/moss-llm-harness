// src/lib/highlight.ts
//
// Shiki highlighter with lazily loaded grammars and themes. Imported on demand
// by RichResponse so the engine stays out of the startup bundle.

import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const { codeToHtml } = createSingletonShorthands(createBundledHighlighter({
  engine: () => createJavaScriptRegexEngine(),
  langs: {
    bash: () => import("@shikijs/langs/bash"),
    css: () => import("@shikijs/langs/css"),
    html: () => import("@shikijs/langs/html"),
    javascript: () => import("@shikijs/langs/javascript"),
    json: () => import("@shikijs/langs/json"),
    markdown: () => import("@shikijs/langs/markdown"),
    powershell: () => import("@shikijs/langs/powershell"),
    python: () => import("@shikijs/langs/python"),
    sql: () => import("@shikijs/langs/sql"),
    tsx: () => import("@shikijs/langs/tsx"),
    typescript: () => import("@shikijs/langs/typescript"),
    yaml: () => import("@shikijs/langs/yaml"),
  },
  themes: {
    "github-dark": () => import("@shikijs/themes/github-dark"),
    "github-light": () => import("@shikijs/themes/github-light"),
  },
}));
