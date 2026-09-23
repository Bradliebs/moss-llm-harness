interface LiveStatusProps {
  message: string;
  className?: string;
  severity?: NotificationSeverity;
  persistent?: boolean;
  action?: { label: string; onSelect: () => void };
  correlationId?: string;
}

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface AppNotification {
  message: string;
  severity: NotificationSeverity;
  persistent: boolean;
  correlationId?: string;
}

function inferredSeverity(message: string): NotificationSeverity {
  if (/(?:\berror\b|\bfailed\b|\bcould not\b|\bunsupported\b|\bunavailable\b)/i.test(message)) return "error";
  if (/(?:\bwarning\b|\bblocked\b|\bdenied\b|\bmissing\b)/i.test(message)) return "warning";
  if (/(?:\bcomplete\b|\bsaved\b|\bupdated\b|\bpassed\b|\bconnected\b)/i.test(message)) return "success";
  return "info";
}

export function notificationFromMessage(
  message: string,
  overrides: Partial<Omit<AppNotification, "message">> = {},
): AppNotification {
  const severity = overrides.severity ?? inferredSeverity(message);
  const persistent = overrides.persistent ?? severity === "error";
  const correlationId = overrides.correlationId
    ?? (severity === "error" ? `MOSS-${Math.abs([...message].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) | 0, 0)).toString(36).toUpperCase()}` : undefined);
  return { message, severity, persistent, ...(correlationId ? { correlationId } : {}) };
}

export function LiveStatus({
  message,
  className = "",
  severity,
  persistent,
  action,
  correlationId,
}: LiveStatusProps): React.ReactElement | null {
  if (!message) return null;
  const notification = notificationFromMessage(message, { severity, persistent, correlationId });
  const assertive = notification.severity === "error";
  return (
    <div
      className={className}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      data-severity={notification.severity}
      data-persistent={notification.persistent ? "true" : "false"}
    >
      <span>{notification.message}</span>
      {notification.correlationId ? (
        <span className="ml-2 font-mono text-[10px] opacity-70">Reference {notification.correlationId}</span>
      ) : null}
      {action ? (
        <button type="button" className="ml-2 underline" onClick={action.onSelect}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
