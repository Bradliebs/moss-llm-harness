// src/lib/notifications.ts
//
// Windows toast notifications for background work. A notification is only
// shown when the user cannot already see the event: the window is hidden or
// unfocused, or the run belongs to a conversation other than the one on screen.

export interface NotifyContext {
  enabled: boolean;
  documentHidden: boolean;
  windowFocused: boolean;
  viewingOwner: boolean;
}

export function shouldNotify(context: NotifyContext): boolean {
  if (!context.enabled) return false;
  return context.documentHidden || !context.windowFocused || !context.viewingOwner;
}

export function currentNotifyContext(enabled: boolean, viewingOwner: boolean): NotifyContext {
  return {
    enabled,
    documentHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
    windowFocused: typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus(),
    viewingOwner,
  };
}

/** Show a desktop notification. Clicking it runs `onClick` (normally focusing
 *  the window and opening the owning conversation). Returns whether one was shown. */
export function showDesktopNotification(title: string, body: string, onClick?: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission === "denied") return false;
  try {
    const notification = new Notification(title, { body, silent: false });
    if (onClick) notification.onclick = () => onClick();
    return true;
  } catch {
    return false;
  }
}
