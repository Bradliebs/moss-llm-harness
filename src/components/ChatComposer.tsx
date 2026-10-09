import { LoaderCircle, Mic, Paperclip, Rocket, SendHorizontal, Square, Zap } from "lucide-react";
import { useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

/** One height and shape for every composer action, with an icon before the text. */
const ACTION = "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors duration-150";
const SECONDARY = `${ACTION} border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700`;
/** Disabled primary actions turn neutral rather than a washed-out green, so "unavailable" reads at a glance. */
const PRIMARY = `${ACTION} bg-emerald-700 px-4 text-white shadow-sm hover:bg-emerald-800 disabled:bg-neutral-300 disabled:text-neutral-600 disabled:shadow-none dark:disabled:bg-neutral-800 dark:disabled:text-neutral-400`;

interface ChatComposerProps {
  children?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onFiles: (files: FileList | null) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  attachmentCount: number;
  dictationState: "idle" | "recording" | "transcribing";
  onToggleDictation: () => void;
  busy: boolean;
  interruptQueued: boolean;
  modelSelected: boolean;
  pendingAttachmentReads: number;
  hasSendContent: boolean;
  launchBlocked: boolean;
  mode: "chat" | "mission";
  onSend: () => void;
  onAbort: () => void;
}

export function ChatComposer({
  children,
  value,
  onValueChange,
  onKeyDown,
  onPaste,
  onFiles,
  composerRef,
  attachmentCount,
  dictationState,
  onToggleDictation,
  busy,
  interruptQueued,
  modelSelected,
  pendingAttachmentReads,
  hasSendContent,
  launchBlocked,
  mode,
  onSend,
  onAbort,
}: ChatComposerProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // Why Send cannot be used yet, shown where the eye already is.
  const blocked = !modelSelected
    ? "Choose a model in Settings to start."
    : pendingAttachmentReads > 0
      ? "Waiting for attachments to finish reading."
      : launchBlocked
        ? "Resolve the mission review items above to launch."
        : "";

  return (
    <footer
      className="relative border-t border-neutral-200 bg-neutral-50/60 px-4 py-3 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-950/60"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        onFiles(event.dataTransfer.files);
      }}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-emerald-500/60 bg-neutral-50/80 text-sm text-emerald-700 dark:bg-neutral-950/80 dark:text-emerald-300">
          Drop files to attach
        </div>
      ) : null}
      {children}
      {!modelSelected && !busy ? <p className="mb-1.5 text-xs text-neutral-600 dark:text-neutral-400">{blocked}</p> : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={composerRef}
          aria-label="Message"
          className="min-w-0 flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3 py-2 text-[0.9375rem] leading-6 shadow-sm transition-colors duration-150 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] dark:border-neutral-700 dark:bg-neutral-900 dark:placeholder:text-neutral-400"
          rows={2}
          placeholder="Message…"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Attach files"
          accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif,.docx,.pdf,.txt,.md,.json,.csv,.tsv,.log,.xml,.yml,.yaml,.toml,.ini,.html,.css,.ts,.tsx,.js,.jsx,.py,.sh,.sql,.rs,.go,.java,.c,.cpp,.rb"
          multiple
          className="hidden"
          onChange={(event) => {
            onFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className={SECONDARY}
          onClick={() => fileInputRef.current?.click()}
          aria-label={`Attach${attachmentCount > 0 ? ` (${attachmentCount})` : ""}`}
          title="Attach an image, Word (.docx), PDF, or text file"
        >
          <Paperclip size={16} aria-hidden="true" />
          <span className="hidden sm:inline">Attach{attachmentCount > 0 ? ` (${attachmentCount})` : ""}</span>
        </button>
        <button
          type="button"
          className={dictationState === "recording" ? `${ACTION} bg-red-700 text-white hover:bg-red-600` : SECONDARY}
          onClick={onToggleDictation}
          disabled={dictationState === "transcribing"}
          aria-pressed={dictationState === "recording"}
          aria-label={dictationState === "recording" ? "Recording" : dictationState === "transcribing" ? "Transcribing" : "Mic"}
          title="Dictate with Whisper"
        >
          {dictationState === "transcribing"
            ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            : <Mic size={16} aria-hidden="true" />}
          <span className="hidden sm:inline">{dictationState === "recording" ? "Recording" : dictationState === "transcribing" ? "Transcribing" : "Mic"}</span>
        </button>
        {busy ? (
          <>
            <button
              type="button"
              className={PRIMARY}
              onClick={onSend}
              disabled={interruptQueued || !modelSelected || pendingAttachmentReads > 0 || !hasSendContent}
              title="Stop the current response and send this message"
            >
              <Zap size={16} aria-hidden="true" />
              {interruptQueued ? "Queued" : "Interrupt"}
            </button>
            <button type="button" className={`${ACTION} bg-red-700 px-4 text-white hover:bg-red-600`} onClick={onAbort}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
              Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            className={PRIMARY}
            onClick={onSend}
            disabled={!modelSelected || pendingAttachmentReads > 0 || launchBlocked}
            title={blocked || undefined}
          >
            {mode === "mission" ? <Rocket size={16} aria-hidden="true" /> : <SendHorizontal size={16} aria-hidden="true" />}
            {mode === "mission" ? "Launch" : "Send"}
          </button>
        )}
      </div>
    </footer>
  );
}
