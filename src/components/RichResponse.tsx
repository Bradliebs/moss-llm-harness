import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { ResultTable } from "./ResultTable";

const { codeToHtml } = createSingletonShorthands(createBundledHighlighter({
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
    void codeToHtml(code, {
      lang: highlightLanguage,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
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

function markdownComponents(onCopy: (text: string) => void, streaming: boolean): Components {
  return {
    ...(streaming ? {} : { table: ResultTable }),
    a: ({ href, children }) => {
      const safeHref = safeExternalUrl(href);
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
    pre: ({ children }) => <CodeBlock onCopy={onCopy}>{children}</CodeBlock>,
    input: (props) => <input {...props} disabled aria-label="Task item" />,
  };
}

export function RichResponse({ content, streaming = false, onCopy }: RichResponseProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
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
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents(onCopy, streaming)}
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