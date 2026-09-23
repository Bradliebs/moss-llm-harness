import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
const distDir = resolve(process.argv[2] ?? "dist");
const indexPath = resolve(distDir, "index.html");
const budgets = {
  initialJavaScript: 675 * 1024,
  initialStyles: 80 * 1024,
};

assert.ok(existsSync(indexPath), `Renderer build not found at ${indexPath}; run npm run build first.`);

function localAsset(fromFile, reference) {
  if (/^(?:[a-z]+:)?\/\//i.test(reference) || reference.startsWith("data:")) return null;
  const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const assetPath = cleanReference.startsWith("/")
    ? resolve(distDir, `.${cleanReference}`)
    : resolve(dirname(fromFile), cleanReference);
  const relativePath = relative(distDir, assetPath);
  assert.ok(
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`),
    `Asset reference escapes the build directory: ${reference}`,
  );
  assert.ok(existsSync(assetPath), `Referenced build asset does not exist: ${assetPath}`);
  return assetPath;
}

const indexHtml = readFileSync(indexPath, "utf8");
const attribute = (tag, name) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
const entryReferences = [...indexHtml.matchAll(/<script\b[^>]*>/gi)]
  .map((match) => match[0])
  .filter((tag) => attribute(tag, "type")?.toLowerCase() === "module")
  .map((tag) => attribute(tag, "src"))
  .filter(Boolean);
const styleReferences = [...indexHtml.matchAll(/<link\b[^>]*>/gi)]
  .map((match) => match[0])
  .filter((tag) => attribute(tag, "rel")?.toLowerCase().split(/\s+/).includes("stylesheet"))
  .map((tag) => attribute(tag, "href"))
  .filter(Boolean);

assert.ok(entryReferences.length > 0, "No module entry point was found in dist/index.html.");

const initialScripts = new Set();
function collectStaticImports(scriptPath) {
  if (initialScripts.has(scriptPath)) return;
  initialScripts.add(scriptPath);
  const source = readFileSync(scriptPath, "utf8");
  const staticImports = source.matchAll(
    /\bimport\s*(?:[\w*{},\s$]+\s+from\s*)?["']([^"']+)["']/g,
  );
  for (const match of staticImports) {
    const importedPath = localAsset(scriptPath, match[1]);
    if (importedPath && [".js", ".mjs"].includes(extname(importedPath))) collectStaticImports(importedPath);
  }
}

for (const reference of entryReferences) {
  const entryPath = localAsset(indexPath, reference);
  assert.ok(entryPath, `Module entry point must be a local build asset: ${reference}`);
  collectStaticImports(entryPath);
}

const initialStyles = new Set(
  styleReferences.map((reference) => localAsset(indexPath, reference)).filter(Boolean),
);
const totalBytes = (paths) => [...paths].reduce((total, path) => total + statSync(path).size, 0);
const formatKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const scriptBytes = totalBytes(initialScripts);
const styleBytes = totalBytes(initialStyles);

console.log(`Initial JavaScript: ${formatKiB(scriptBytes)} / ${formatKiB(budgets.initialJavaScript)}`);
console.log(`Initial styles: ${formatKiB(styleBytes)} / ${formatKiB(budgets.initialStyles)}`);
console.log(
  `Entrypoints: ${[...initialScripts].map((path) => relative(distDir, path)).join(", ")}`,
);

assert.ok(
  scriptBytes <= budgets.initialJavaScript,
  `Initial JavaScript exceeds its budget by ${formatKiB(scriptBytes - budgets.initialJavaScript)}.`,
);
assert.ok(
  styleBytes <= budgets.initialStyles,
  `Initial styles exceed their budget by ${formatKiB(styleBytes - budgets.initialStyles)}.`,
);

console.log("Renderer bundle budget passed.");
