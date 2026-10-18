import { Check, Copy, ExternalLink, ImageOff } from "lucide-react";
import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { rehypeAllowedHtml, richUrlTransform, SAFE_DATA_IMAGE, sanitizeSchema } from "../lib/richMarkdown";
import { ResultTable } from "./ResultTable";

// The highlighter engine loads with the first code block, not at startup.
const loadHighlighter = (): Promise<typeof import("../lib/highlight")> => import("../lib/highlight");

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  md: "markdown",
  ps1: "powershell",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};
const HIGHLIGHTED_LANGUAGES = new Set([
  "bash", "css", "html", "javascript", "json", "markdown", "powershell",
  "python", "sql", "tsx", "typescript", "yaml",
]);

interface RichResponseProps {
  content: string;
  streaming?: boolean;
  onCopy: (text: string) => void;
  /** where relative image and file paths in the reply point */
  workspaceRoot?: string | null;
}

interface SelectionCopyState {
  text: string;
  left: number;
  top: number;
}

function safeExternalUrl(value?: string): string | undefined {
  return value && /^(https?:|mailto:)/i.test(value) ? value : undefined;
}

function IconCopyButton({ text, onCopy }: { text: string; onCopy: (text: string) => void }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      className="response-icon-button"
      aria-label={copied ? "Code copied" : "Copy code"}
      title={copied ? "Copied" : "Copy code"}
      onClick={() => {
        onCopy(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

function textFromNode(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("")
    .replace(/\n$/, "");
}

function CodeBlock({ children, onCopy }: { children: ReactNode; onCopy: (text: string) => void }): ReactElement {
  const codeElement = Children.toArray(children).find((child) => isValidElement(child));
  const codeProps = isValidElement<{ className?: string; children?: ReactNode }>(codeElement)
    ? codeElement.props
    : undefined;
  const language = codeProps?.className?.match(/language-([\w-]+)/)?.[1] ?? "text";
  const normalizedLanguage = LANGUAGE_ALIASES[language] ?? language;
  const highlightLanguage = HIGHLIGHTED_LANGUAGES.has(normalizedLanguage) ? normalizedLanguage : "text";
  const code = textFromNode(codeProps?.children);
  const [highlighted, setHighlighted] = useState("");

  useEffect(() => {
    let active = true;
    void loadHighlighter().then(({ codeToHtml }) => codeToHtml(code, {
      lang: highlightLanguage,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }))
      .then((html) => {
        if (active) setHighlighted(html);
      })
      .catch(() => {
        if (active) setHighlighted("");
      });
    return () => {
      active = false;
    };
  }, [code, highlightLanguage]);

  return (
    <figure className="response-code">
      <figcaption>
        <span>{language}</span>
        <IconCopyButton text={code} onCopy={onCopy} />
      </figcaption>
      {highlighted ? (
        <div className="response-code-highlight" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <pre><code>{code}</code></pre>
      )}
    </figure>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** An image in a reply. Raster data URLs show as they are and workspace files
 *  are read through the main process each time the image appears, so a chart
 *  the agent rewrites shows its new version. Web images become a link instead:
 *  loading one would send a request (and anything in its URL) to that site unasked. */
function MarkdownImage({ src, alt, workspaceRoot }: { src?: string; alt?: string; workspaceRoot?: string | null }): ReactElement {
  const label = alt?.trim() || "image";
  const remote = !!src && /^https?:/i.test(src);
  const inline = !!src && SAFE_DATA_IMAGE.test(src);
  const reader = typeof window !== "undefined" ? window.moss?.workspace?.image : undefined;
  const [loaded, setLoaded] = useState<string | null | undefined>(inline ? src : undefined);

  useEffect(() => {
    if (inline || remote || !src) return;
    if (!workspaceRoot || !reader) {
      setLoaded(null);
      return;
    }
    let active = true;
    void reader(workspaceRoot, src).catch(() => null).then((url) => { if (active) setLoaded(url); });
    return () => {
      active = false;
    };
  }, [src, inline, remote, workspaceRoot, reader]);

  if (remote) {
    return (
      <a
        href={src}
        className="response-image-link"
        title={`Open ${src} in your browser`}
        onClick={(event) => {
          event.preventDefault();
          void window.moss.shell?.openExternal(src!);
        }}
      >
        <ExternalLink size={14} aria-hidden="true" />
        <span>Image: {label} ({hostOf(src!)})</span>
      </a>
    );
  }
  if (loaded) return <img src={loaded} alt={alt ?? ""} className="response-image" loading="lazy" />;
  if (loaded === undefined) return <span className="response-image-link" aria-busy="true">Loading image: {label}</span>;
  return (
    <span className="response-image-link" title={src}>
      <ImageOff size={14} aria-hidden="true" />
      <span>Image not found: {src || label}</span>
    </span>
  );
}

function markdownComponents(onCopy: (text: string) => void, streaming: boolean, workspaceRoot?: string | null): Components {
  return {
    ...(streaming ? {} : { table: ResultTable }),
    // The page has its own h1 (the conversation); an answer's top heading sits below it.
    h1: ({ children }) => <h2 data-level="1">{children}</h2>,
    a: ({ href, children }) => {
      const safeHref = safeExternalUrl(href);
      // A relative link names a file in the workspace: a page opens in the
      // browser, anything else shows its path rather than a dead link.
      if (!safeHref && href && workspaceRoot && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const path = href.replace(/[?#].*$/, "");
        if (/\.html?$/i.test(path) && window.moss?.workspace?.openInBrowser) {
          return (
            <a
              href={href}
              title={`Open ${path} in your browser`}
              onClick={(event) => {
                event.preventDefault();
                void window.moss.workspace.openInBrowser?.(workspaceRoot, path);
              }}
            >
              {children}
            </a>
          );
        }
        return <span title={`${path} in the workspace`}>{children}</span>;
      }
      return (
        <a
          href={safeHref}
          title={safeHref}
          onClick={(event) => {
            event.preventDefault();
            if (safeHref) void window.moss.shell?.openExternal(safeHref);
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} workspaceRoot={workspaceRoot} />,
    pre: ({ children }) => <CodeBlock onCopy={onCopy}>{children}</CodeBlock>,
    input: (props) => <input {...props} disabled aria-label="Task item" />,
  };
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeAllowedHtml, [rehypeSanitize, sanitizeSchema]] as NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]>;

/** Re-renders only when its text, streaming state, or workspace changes: while
 *  one answer streams, earlier answers are not parsed again on every token.
 *  `onCopy` is left out on purpose: callers pass a stable function. */
export const RichResponse = memo(RichResponseView, (prev, next) => prev.content === next.content && prev.streaming === next.streaming && prev.workspaceRoot === next.workspaceRoot);

function RichResponseView({ content, streaming = false, onCopy, workspaceRoot }: RichResponseProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  // The markdown component map must keep its identity across renders, or React
  // treats every code block as a new component and remounts it on each token.
  const components = useMemo(() => markdownComponents(onCopy, streaming, workspaceRoot), [onCopy, streaming, workspaceRoot]);
  const [selectionCopy, setSelectionCopy] = useState<SelectionCopyState | null>(null);

  useEffect(() => {
    function updateSelectionCopy(): void {
      const selection = window.getSelection();
      const root = rootRef.current;
      if (
        !selection
        || selection.isCollapsed
        || !selection.anchorNode
        || !selection.focusNode
        || !root?.contains(selection.anchorNode)
        || !root.contains(selection.focusNode)
      ) {
        setSelectionCopy(null);
        return;
      }

      const text = selection.toString();
      if (!text.trim()) {
        setSelectionCopy(null);
        return;
      }

      const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
      setSelectionCopy({ text, left: rect.left + rect.width / 2, top: rect.top - 8 });
    }

    document.addEventListener("selectionchange", updateSelectionCopy);
    window.addEventListener("scroll", updateSelectionCopy, true);
    return () => {
      document.removeEventListener("selectionchange", updateSelectionCopy);
      window.removeEventListener("scroll", updateSelectionCopy, true);
    };
  }, []);

  return (
    <div ref={rootRef} className={`rich-response${streaming ? " is-streaming" : ""}`} data-testid="rich-response">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={richUrlTransform}
        components={components}
      >
        {content}
      </ReactMarkdown>
      {streaming ? <span className="stream-caret" aria-label="Moss is writing" /> : null}
      {selectionCopy ? (
        <button
          type="button"
          className="selection-copy-button"
          style={{ left: selectionCopy.left, top: selectionCopy.top }}
          aria-label="Copy selection"
          title="Copy selection"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onCopy(selectionCopy.text);
            setSelectionCopy(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <Copy size={14} aria-hidden="true" />
          <span>Copy</span>
        </button>
      ) : null}
    </div>
  );
}