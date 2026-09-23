export type ProductEvalArea = "setup" | "recovery" | "intervention" | "background";

export interface ProductUxEvalCase {
  id: string;
  area: ProductEvalArea;
  trigger: string;
  expectedState: string;
  expectedActions: string[];
  forbiddenOutcomes: string[];
  measuredBy: Array<
    "intervention-count"
    | "blocker-recovery"
    | "approval-latency"
    | "error-quality"
    | "false-completion"
  >;
  executableEvidence: { path: string; testName: string };
}

export const PRODUCT_UX_EVAL_CASES: readonly ProductUxEvalCase[] = [
  {
    id: "provider-setup-failure-recovery",
    area: "setup",
    trigger: "Provider authentication fails, then valid credentials are saved.",
    expectedState: "Readiness preserves configuration, explains authentication, and becomes ready after retry.",
    expectedActions: ["Open provider settings", "Retry connection"],
    forbiddenOutcomes: ["Clear unrelated settings", "Display a raw provider response"],
    measuredBy: ["blocker-recovery", "error-quality"],
    executableEvidence: { path: "src/components/SettingsPanel.test.tsx", testName: "announces provider failures as an alert" },
  },
  {
    id: "unverifiable-mission-criteria",
    area: "setup",
    trigger: "A mandatory mission criterion has no verification binding.",
    expectedState: "Mission launch remains blocked and focuses the incomplete outcome contract.",
    expectedActions: ["Choose a host-run verification method"],
    forbiddenOutcomes: ["Authorize mission", "Report completion"],
    measuredBy: ["intervention-count", "false-completion"],
    executableEvidence: { path: "src/components/MissionReview.test.tsx", testName: "updates the measurable outcome and verification method" },
  },
  {
    id: "unknown-model-pricing",
    area: "setup",
    trigger: "A cost-bounded mission uses a model without configured pricing.",
    expectedState: "Mission launch fails closed with a direct link to model pricing settings.",
    expectedActions: ["Configure model pricing"],
    forbiddenOutcomes: ["Assume zero cost", "Start cost-bounded execution"],
    measuredBy: ["error-quality", "false-completion"],
    executableEvidence: { path: "electron/backend/moss/task/mission-budget.test.ts", testName: "fails closed on unknown model prices for cost-limited work" },
  },
  {
    id: "unavailable-capability",
    area: "setup",
    trigger: "A mission template requests a capability absent from current readiness.",
    expectedState: "The template remains editable and names the missing prerequisite.",
    expectedActions: ["Open readiness settings", "Select an available capability"],
    forbiddenOutcomes: ["Silently drop the capability", "Bypass preflight"],
    measuredBy: ["intervention-count", "error-quality"],
    executableEvidence: { path: "electron/backend/moss/capabilities/live-capabilities.test.ts", testName: "filters known credential-dependent capabilities until configured" },
  },
  {
    id: "approval-denial-revised-plan",
    area: "intervention",
    trigger: "The user denies a mutating approval and explains the constraint.",
    expectedState: "The denial is durable and the mission blocks or replans without executing the denied action.",
    expectedActions: ["Inspect revised plan", "Resume when safe"],
    forbiddenOutcomes: ["Replay denied action", "Treat denial as approval"],
    measuredBy: ["intervention-count", "approval-latency", "blocker-recovery"],
    executableEvidence: { path: "electron/backend/moss/evals/representative-corpus.e2e.test.ts", testName: "approval-policy-perturbed" },
  },
  {
    id: "post-compaction-continuation",
    area: "recovery",
    trigger: "Context compaction occurs before the next dependency-ready step.",
    expectedState: "Execution continues from durable progress without replaying completed work.",
    expectedActions: ["Inspect retained progress"],
    forbiddenOutcomes: ["Guess dropped state", "Restart completed steps"],
    measuredBy: ["blocker-recovery", "false-completion"],
    executableEvidence: { path: "electron/backend/moss/evals/context-cases.test.ts", testName: "executes compaction and real file recovery" },
  },
  {
    id: "reload-during-approval",
    area: "recovery",
    trigger: "The renderer reloads while a tool approval is pending.",
    expectedState: "The durable task pauses and records an interrupted approval for explicit recovery.",
    expectedActions: ["Reopen the task", "Review the approval"],
    forbiddenOutcomes: ["Execute without approval", "Lose the task"],
    measuredBy: ["approval-latency", "blocker-recovery"],
    executableEvidence: { path: "electron/ipc/chat-ipc.e2e.test.ts", testName: "interrupts a pending durable approval" },
  },
  {
    id: "configuration-change-recovery",
    area: "recovery",
    trigger: "A blocked mission prerequisite is fixed in Settings.",
    expectedState: "Last-known task state remains visible and the mission can be reviewed and resumed.",
    expectedActions: ["Review mission", "Resume"],
    forbiddenOutcomes: ["Create a duplicate task", "Discard evidence"],
    measuredBy: ["intervention-count", "blocker-recovery"],
    executableEvidence: { path: "src/components/MissionMonitor.test.tsx", testName: "labels blocker recovery and suppresses unsafe resume" },
  },
  {
    id: "background-mission-inspection",
    area: "background",
    trigger: "The user switches conversations while a durable mission continues.",
    expectedState: "The active run remains bound to its original conversation and appears in Run center.",
    expectedActions: ["Inspect active run", "Return to running conversation"],
    forbiddenOutcomes: ["Leak transient output into another conversation", "Interrupt the run on navigation"],
    measuredBy: ["intervention-count", "false-completion"],
    executableEvidence: { path: "src/components/ChatPanel.test.tsx", testName: "keeps in-flight output bound to its owning conversation during background inspection" },
  },
];
