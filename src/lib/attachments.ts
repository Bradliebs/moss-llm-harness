// src/lib/attachments.ts
//
// Pure helpers for chat attachments: validating picked files before they become
// data-URL image attachments, and a heuristic for whether the selected model is
// likely to accept images. Document parsers are loaded only when needed.

/** Maximum size for an inline image attachment. base64 data URLs inflate the
 *  payload by ~33% and providers reject oversized requests, so cap before
 *  encoding rather than after. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Maximum size for a text file inlined into the prompt as a fenced block.
 *  A large dump silently bloats the context window and provider request, so
 *  reject before reading rather than after. */
export const MAX_TEXT_BYTES = 256 * 1024;

/** Maximum PDF size accepted for local text extraction. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function imageMediaType(file: { type: string; name: string }): string | null {
  if (file.type.startsWith("image/")) return file.type;
  if (file.type && file.type !== "application/octet-stream") return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mediaTypes: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : null;
}

/** Validate a picked file destined to become an image attachment. Returns a
 *  short error string to show the user, or null when the file is acceptable.
 *  Drag-drop and paste bypass the file picker's accept filter, so this guards
 *  against non-image and oversized files reaching the providers. */
export function imageAttachmentError(file: { type: string; size: number; name: string }): string | null {
  if (!imageMediaType(file)) return `${file.name}: not an image`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: image is larger than 10 MB`;
  return null;
}

/** Validate a picked file destined to be inlined as text. Returns a short error
 *  string to show the user, or null when the file is acceptable. */
export function textAttachmentError(file: { size: number; name: string }): string | null {
  if (file.size > MAX_TEXT_BYTES) return `${file.name}: text file is larger than 256 KB`;
  return null;
}

/** Extract readable text from a PDF while preserving page boundaries. */
export async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;

  const loadingTask = getDocument({ data: new Uint8Array(data) });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim());
      page.cleanup();
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

export function isDocxFile(file: { type: string; name: string }): boolean {
  return file.type === DOCX_MEDIA_TYPE || file.name.toLowerCase().endsWith(".docx");
}

export async function extractDocxText(data: ArrayBuffer): Promise<string> {
  const { default: mammoth } = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  const error = result.messages.find((message) => message.type === "error");
  if (error) throw new Error(error.message);
  return result.value;
}

/** File extensions inlined as fenced text. Binary documents use separate parsers.
 *  The value is a code-fence language hint, "" when no useful highlight applies. */
export const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  txt: "",
  md: "markdown",
  json: "json",
  csv: "",
  tsv: "",
  log: "",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  html: "html",
  css: "css",
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "python",
  sh: "bash",
  sql: "sql",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  rb: "ruby",
};

/** Resolve a filename to a fenced-code language hint when it is a text-like type,
 *  or null when it is not. text/* MIME files default to a plain fence. */
export function textLanguageForFile(file: { type: string; name: string }): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext in TEXT_EXTENSIONS) return TEXT_EXTENSIONS[ext];
  if (file.type.startsWith("text/")) return "";
  return null;
}

export function isPdfFile(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Substrings of model ids known to be vision-capable, matched case-insensitively.
 *  Data-driven so a new model is a one-line addition. Provider kind is deliberately
 *  not a key: vision support is a property of the model, not the endpoint serving
 *  it, so a model name alone determines the answer. */
export const VISION_MODEL_MARKERS: readonly string[] = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-4-vision",
  "o3",
  "o4",
  "claude-3",
  "claude-4",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini",
  "llava",
  "llama-3.2",
  "llama3.2",
  "llama-4",
  "llama4",
  "pixtral",
  "moondream",
  "minicpm-v",
  "qwen2-vl",
  "qwen2.5-vl",
  "vision",
];

/** Heuristic: does the model name look vision-capable? Used only to show an
 *  advisory warning when images are attached, never to block sending. The marker
 *  list is necessarily incomplete, so a false negative just shows a dismissible
 *  hint rather than preventing the request. */
export function isLikelyVisionModel(model: string): boolean {
  const m = model.toLowerCase();
  return VISION_MODEL_MARKERS.some((marker) => m.includes(marker));
}
