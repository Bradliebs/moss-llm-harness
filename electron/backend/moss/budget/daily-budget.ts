// electron/backend/moss/budget/daily-budget.ts
//
// A soft daily spend cap for cloud LLM usage. Spend is tracked per UTC day in
// <userData>/daily-budget.json and reset automatically when the day rolls over.
// Reads never throw: a missing or corrupt file yields a fresh zero-spend day.
// Writes go through the atomic helper so a crash mid-write cannot corrupt the
// ledger. The cap is "soft": a single in-flight turn is only charged after it
// completes, so one turn may overshoot, but the next request is blocked.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import { writeFileAtomicSync } from "../persistence/atomic-file";

const log = createLogger("Budget");

interface BudgetState {
  /** UTC calendar day, YYYY-MM-DD, the spend is attributed to */
  day: string;
  /** total USD recorded for that day */
  spentUsd: number;
}

/** Current UTC calendar day. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DailyBudget {
  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "daily-budget.json");
  }

  /** Read the ledger, collapsing a stale day to zero spend. */
  private read(): BudgetState {
    try {
      const parsed = JSON.parse(readFileSync(this.file(), "utf8")) as Partial<BudgetState>;
      if (parsed && typeof parsed.day === "string" && typeof parsed.spentUsd === "number") {
        return parsed.day === today() ? { day: parsed.day, spentUsd: parsed.spentUsd } : { day: today(), spentUsd: 0 };
      }
    } catch {
      /* missing or corrupt — treat as a fresh day */
    }
    return { day: today(), spentUsd: 0 };
  }

  /** USD spent so far today (0 when the stored day is not today). */
  spentToday(): number {
    return this.read().spentUsd;
  }

  /** Add to today's spend, resetting first when the stored day rolled over.
   *  Non-positive amounts are ignored. Best-effort: a write failure is logged. */
  record(usd: number): void {
    if (!(usd > 0)) return;
    const state = this.read();
    const next: BudgetState = { day: today(), spentUsd: state.spentUsd + usd };
    try {
      writeFileAtomicSync(this.file(), `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      log.error("failed to record spend", err);
    }
  }
}

/** Singleton used by the budget-enforcing provider wrapper. */
export const dailyBudget = new DailyBudget();
