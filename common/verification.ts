export interface JsonArtifactRequirement {
  sourcePath: string;
  valuePath: string[];
  outputPath: string;
  onReadFailure?: "require-absent";
}

export interface VerificationCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  checkIds: string[];
}

export interface VerificationCheckBase {
  id: string;
  criterionId: string;
  kind: string;
}

export interface CommandVerificationCheck extends VerificationCheckBase {
  kind: "command";
  command: string;
}

export interface FileExistsVerificationCheck extends VerificationCheckBase {
  kind: "file-exists";
  path: string;
}

export interface FileContainsVerificationCheck extends VerificationCheckBase {
  kind: "file-contains";
  path: string;
  substring: string;
}

export interface ProcessRunningVerificationCheck extends VerificationCheckBase {
  kind: "process-running";
  pid: number;
}

export interface HttpVerificationCheck extends VerificationCheckBase {
  kind: "http";
  url: string;
  method?: string;
  expectedStatus?: number;
  bodyIncludes?: string;
  timeoutMs?: number;
}

export interface ReceiptVerificationCheck extends VerificationCheckBase {
  kind: "receipt";
  asserted: boolean;
  receipt?: string;
  source?: "manual" | "external";
}

export type VerificationCheck =
  | CommandVerificationCheck
  | FileExistsVerificationCheck
  | FileContainsVerificationCheck
  | ProcessRunningVerificationCheck
  | HttpVerificationCheck
  | ReceiptVerificationCheck
  | VerificationCheckBase;

export interface VerificationEvidence {
  criterionId: string;
  checkId: string;
  kind: string;
  ok: boolean;
  timestamp: string;
  summary: string;
  details?: string;
  failureKind?: "assertion" | "grader" | "environment" | "orchestration";
}