// src/components/ReadinessIcon.tsx
//
// A readiness status shown by shape and words as well as colour.

import { CircleAlert, CircleCheck, CircleMinus } from "lucide-react";

import type { ReadinessItem } from "../lib/settings";

const STATUS = {
  ready: { icon: CircleCheck, className: "text-emerald-700 dark:text-emerald-400", word: "ready" },
  attention: { icon: CircleAlert, className: "text-amber-700 dark:text-amber-400", word: "needs attention" },
  optional: { icon: CircleMinus, className: "text-neutral-500 dark:text-neutral-400", word: "optional" },
} as const;

export function ReadinessIcon({ status, className = "" }: { status: ReadinessItem["status"]; className?: string }): React.ReactElement {
  const { icon: Icon, className: tone, word } = STATUS[status];
  return (
    <>
      <Icon size={14} className={`shrink-0 ${tone} ${className}`} aria-hidden="true" />
      <span className="sr-only">{word}: </span>
    </>
  );
}
