// src/lib/toolStatus.ts
//
// Tool call lifecycle status and its accent color. Kept dependency-free and
// DOM-free so the color mapping unit-tests in node. Each color ships a light
// default plus a dark: variant so the accent stays readable on both themes.

export type ToolStatus = "approval" | "running" | "done" | "denied" | "error";

export function toolStatusColor(status: ToolStatus): string {
  switch (status) {
    case "done":
      return "text-emerald-700 dark:text-emerald-400";
    case "running":
      return "text-sky-700 dark:text-sky-400";
    case "error":
    case "denied":
      return "text-red-700 dark:text-red-400";
    default:
      return "text-neutral-600 dark:text-neutral-400";
  }
}
