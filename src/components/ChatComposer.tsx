import { useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

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
      <div className="flex gap-2">
        <textarea
          ref={composerRef}
          className="flex-1 resize-none rounded-xl border border-neutral-300/60 bg-neutral-200 px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40 dark:border-neutral-700/60 dark:bg-neutral-800"
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
          className="rounded-xl bg-neutral-300 px-3 py-2 transition hover:bg-neutral-400 dark:bg-neutral-700 dark:hover:bg-neutral-600"
          onClick={() => fileInputRef.current?.click()}
          title="Attach an image, Word (.docx), PDF, or text file"
        >
          Attach{attachmentCount > 0 ? ` (${attachmentCount})` : ""}
        </button>
        <button
          className={`rounded-xl px-3 py-2 transition disabled:opacity-50 ${
            dictationState === "recording"
              ? "bg-red-700 hover:bg-red-600"
              : "bg-neutral-300 hover:bg-neutral-400 dark:bg-neutral-700 dark:hover:bg-neutral-600"
          }`}
          onClick={onToggleDictation}
          disabled={dictationState === "transcribing"}
          title="Dictate with Whisper"
        >
          {dictationState === "recording" ? "Recording" : dictationState === "transcribing" ? "…" : "Mic"}
        </button>
        {busy ? (
          <>
            <button
              className="rounded-xl bg-emerald-700 px-4 py-2 font-medium text-white shadow transition hover:bg-emerald-600 disabled:opacity-50"
              onClick={onSend}
              disabled={interruptQueued || !modelSelected || pendingAttachmentReads > 0 || !hasSendContent}
              title="Stop the current response and send this message"
            >
              {interruptQueued ? "Queued" : "Interrupt"}
            </button>
            <button className="rounded-xl bg-red-700 px-4 py-2 font-medium text-white transition hover:bg-red-600" onClick={onAbort}>
              Stop
            </button>
          </>
        ) : (
          <button
            className="rounded-xl bg-emerald-700 px-4 py-2 font-medium text-white shadow transition hover:bg-emerald-600 disabled:opacity-50"
            onClick={onSend}
            disabled={!modelSelected || pendingAttachmentReads > 0 || launchBlocked}
          >
            {mode === "mission" ? "Launch" : "Send"}
          </button>
        )}
      </div>
    </footer>
  );
}
