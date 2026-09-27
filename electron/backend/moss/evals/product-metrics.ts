import type {
  EvalBenchmarkControls,
  HarnessExecutionTrace,
  HarnessProductMetrics,
} from "../../../../common/evals";

export function measureProductMetrics(
  trace: HarnessExecutionTrace | undefined,
  benchmark: EvalBenchmarkControls | undefined,
): HarnessProductMetrics {
  if (!trace) {
    return {
      interventionCount: 0,
      recoveryAttempts: 0,
      recoverySucceeded: false,
      userVisibleErrorQuality: "generic",
      falseCompletion: false,
    };
  }

  const approvalRequests = trace.events.filter((event) => event.type === "approval-requested");
  const approvalDecisions = trace.events.filter((event) => event.type === "approval-decision");
  const recoveries = trace.events.filter((event) => event.type === "recovery");
  const firstApproval = approvalRequests[0];
  const firstDecision = approvalDecisions[0];
  const approvalLatencyMs = firstApproval && firstDecision
    ? Math.max(0, Date.parse(firstDecision.timestamp) - Date.parse(firstApproval.timestamp))
    : undefined;
  const successfulVerification = trace.events.some((event) => event.type === "verification" && event.ok);
  const completed = trace.terminalState === "completed";
  const requiresVerification = benchmark?.requireVerificationBeforeCompletion === true;
  const terminalFailure = trace.terminalState === "error" || trace.terminalState === "blocked";
  const classifiedRecovery = recoveries.some((event) => event.classification);

  return {
    interventionCount: approvalDecisions.length,
    recoveryAttempts: recoveries.length,
    recoverySucceeded: recoveries.some((event) => event.outcome === "succeeded"),
    ...(approvalLatencyMs === undefined ? {} : { approvalLatencyMs }),
    userVisibleErrorQuality: terminalFailure ? (classifiedRecovery ? "actionable" : "generic") : "not-applicable",
    falseCompletion: completed && requiresVerification && !successfulVerification,
  };
}
