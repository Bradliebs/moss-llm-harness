// electron/backend/moss/safety/irreversible.ts
//
// Words that name a final, hard-to-undo action on a page or in an app: buying,
// paying, sending, submitting, deleting. One list serves the permission policy
// and the built-in browser and desktop tools, so they agree on what needs a
// person. Matching is on labels (the button or control being acted on), not on
// every argument, so typed text and URLs do not trigger it by accident.

// Words that also name ordinary things ("Order history", "Address book",
// "Post code") count only in their action form.
export const IRREVERSIBLE_ACTION_PATTERN = new RegExp([
  "\\b(?:delete|destroy|remove|erase|wipe|submit|publish|pay|payment|paypal|send|confirm|purchase|buy|checkout|check\\s+out|transfer|withdraw|donate|reserve|subscribe)\\b",
  "\\bpost\\b(?!\\s*(?:code|office|box|s\\b))",
  "\\b(?:place|complete|submit|confirm)\\s+(?:your\\s+|the\\s+)?order\\b|\\border\\s+now\\b|^\\s*order\\s*$",
  "\\bbook\\s+(?:now|it|this|a|an|the|your|room|flight|table|ticket|appointment|stay)\\b|^\\s*book\\s*$",
].join("|"), "i");

/** Argument keys that hold the label of what is being clicked or invoked. */
const LABEL_KEYS = new Set(["element", "name", "label", "title", "button", "control"]);

export function namesIrreversibleAction(text: string): boolean {
  return IRREVERSIBLE_ACTION_PATTERN.test(text);
}

/** True when any label in the arguments, at any depth, names an irreversible action. */
export function labelsNameIrreversibleAction(args: Readonly<Record<string, unknown>> | undefined): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
      (LABEL_KEYS.has(key.toLowerCase()) && typeof item === "string" && namesIrreversibleAction(item)) || visit(item));
  };
  return visit(args);
}
