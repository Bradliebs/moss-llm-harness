/// <reference types="vite/client" />

import type {
  ChatEventPayload,
  ChatStartRequest,
  CheckpointFile,
  CheckpointRevertResult,
  CodebaseReindexResult,
  CodebaseStatus,
  EmbedConfig,
  HandoffSummaryRequest,
  HandoffSummaryResult,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  MissionAuthorization,
  MissionAuthorizationRequest,
  MissionCapabilitiesRequest,
  MissionCapabilityDescriptor,
  ModelCapabilityProfile,
  ModelPerformanceEntry,
  OllamaContextReport,
  PracticeConfig,
  Procedure,
  ProcedureStatus,
  PracticeProgress,
  PracticeReport,
  SetupDetection,
  SetupDetectionRequest,
  ModelProbeProgress,
  ModelProbeRequest,
  ProviderConfig,
  ProviderKind,
  ProductDiagnosticEntry,
  ProductDiagnosticsConfig,
  Skill,
  SkillCreateRequest,
  SkillImportResult,
  SkillUpdateRequest,
  SkillRenameRequest,
  SkillTrust,
  SkillTrustStatus,
  TaskArtifactContent,
  TaskHistoryEntry,
  TaskSnapshot,
  TaskSpec,
  ToolApprovalDecision,
  TranscribeRequest,
  TranscribeResult,
  ReplayReport,
  TraceReplayRequest,
  TurnTraceSummary,
  VerificationSuggestion,
  WorkspaceFilePreview,
} from "@common/types";

declare global {
  /** Server shape accepted by the settings UI add/edit form and returned by
   *  mcp.servers(). A structural subset of the backend McpServerConfig: only the
   *  fields the form reads or writes (env/cwd/headers stay file-edited). */
  type MossMcpServerInput =
    | { type: "stdio"; id: string; command: string; args?: string[]; enabled?: boolean; trustAnnotations?: boolean }
    | { type: "http"; id: string; url: string; enabled?: boolean; trustAnnotations?: boolean };


  interface Window {
    moss: {
      chat: {
        send: (request: ChatStartRequest) => void;
        abort: (turnId: string) => void;
        summarize: (request: HandoffSummaryRequest) => Promise<HandoffSummaryResult>;
        onEvent: (handler: (payload: ChatEventPayload) => void) => () => void;
      };
      tool: {
        approve: (decision: ToolApprovalDecision) => void;
      };
      task: {
        create: (spec: TaskSpec, id?: string) => Promise<TaskSnapshot>;
        list: () => Promise<TaskSnapshot[]>;
        get: (id: string) => Promise<TaskSnapshot | null>;
        history: (id: string) => Promise<TaskHistoryEntry[]>;
        artifact: (taskId: string, artifactId: string) => Promise<TaskArtifactContent | null>;
        start: (id: string) => Promise<TaskSnapshot>;
        pause: (id: string, summary: string) => Promise<TaskSnapshot>;
        resume: (id: string) => Promise<TaskSnapshot>;
        cancel: (id: string) => Promise<TaskSnapshot>;
      };
      diagnostics: {
        list: () => Promise<{ config: ProductDiagnosticsConfig; entries: ProductDiagnosticEntry[] }>;
        configure: (config: ProductDiagnosticsConfig) => Promise<ProductDiagnosticsConfig>;
        clear: () => Promise<void>;
        record: (kind: "renderer-startup") => Promise<void>;
      };
      mission: {
        authorize: (request: MissionAuthorizationRequest) => Promise<MissionAuthorization | null>;
        capabilities: (request: MissionCapabilitiesRequest) => Promise<MissionCapabilityDescriptor[]>;
      };
      provider: {
        listModels: (config: ProviderConfig) => Promise<string[]>;
        getCredential: (providerId: string) => Promise<string>;
        setCredential: (providerId: string, apiKey: string) => Promise<void>;
      };
      workspace: {
        pick: () => Promise<string | null>;
        preview?: (root: string, path: string) => Promise<WorkspaceFilePreview>;
        suggestVerification?: (root: string) => Promise<VerificationSuggestion[]>;
      };
      window?: {
        focus: () => Promise<void>;
      };
      model?: {
        probe: (request: ModelProbeRequest) => Promise<ModelCapabilityProfile>;
        cancelProbe: () => Promise<void>;
        profile: (kind: ProviderKind, baseUrl: string, model: string) => Promise<ModelCapabilityProfile | null>;
        profiles: () => Promise<ModelCapabilityProfile[]>;
        performance?: () => Promise<ModelPerformanceEntry[]>;
        clearPerformance?: (kind: ProviderKind, baseUrl: string, model: string) => Promise<void>;
        inspectContext?: (baseUrl: string, model: string) => Promise<OllamaContextReport>;
        createContextVariant?: (baseUrl: string, model: string, numCtx: number) => Promise<string>;
        onProbeProgress: (handler: (progress: ModelProbeProgress) => void) => () => void;
      };
      procedures?: {
        list: () => Promise<Procedure[]>;
        setStatus: (id: string, status: ProcedureStatus) => Promise<Procedure[]>;
        remove: (id: string) => Promise<Procedure[]>;
      };
      practice?: {
        get: () => Promise<{ config: PracticeConfig; latest: PracticeReport | null; running: boolean }>;
        configure: (config: PracticeConfig) => Promise<PracticeConfig>;
        run: () => Promise<PracticeReport>;
        cancel: () => Promise<void>;
        onProgress: (handler: (progress: PracticeProgress) => void) => () => void;
      };
      setup?: {
        detect: (request: SetupDetectionRequest) => Promise<SetupDetection>;
        pull: (baseUrl: string, model: string) => Promise<void>;
      };
      traces?: {
        list: () => Promise<{ count: number; traces: TurnTraceSummary[]; dir: string }>;
        clear: () => Promise<void>;
        openFolder: () => Promise<string | null>;
        replay: (request: TraceReplayRequest) => Promise<ReplayReport>;
        cancelReplay: () => Promise<void>;
        onReplayProgress: (handler: (progress: { completed: number; total: number }) => void) => () => void;
      };
      memory: {
        list: () => Promise<MemoryEntry[]>;
        add: (fact: string, category: MemoryCategory) => Promise<MemoryEntry | null>;
        delete: (id: string) => Promise<boolean>;
        clear: () => Promise<void>;
        reviewList: () => Promise<MemoryEntry[]>;
        reviewApprove: (id: string) => Promise<MemoryEntry | null>;
        reviewReject: (id: string) => Promise<boolean>;
      };
      skills: {
        list: () => Promise<Skill[]>;
        create: (request: SkillCreateRequest) => Promise<Skill>;
        delete: (id: string) => Promise<boolean>;
        toggle: (id: string, enabled: boolean) => Promise<void>;
        update: (request: SkillUpdateRequest) => Promise<Skill | null>;
        rename: (request: SkillRenameRequest) => Promise<Skill | null>;
        importFolder: () => Promise<SkillImportResult | null>;
        setTrust?: (id: string, status: SkillTrustStatus) => Promise<SkillTrust | null>;
        history?: (id: string) => Promise<Array<{ version: number; savedAt: string; description: string; instructions: string }>>;
        rollback?: (id: string, version: number) => Promise<Skill | null>;
      };
      mcp: {
        status: () => Promise<McpServerStatus[]>;
        setEnabled: (id: string, enabled: boolean) => Promise<McpServerStatus[]>;
        openConfig: () => Promise<string | null>;
        add: (config: MossMcpServerInput) => Promise<McpServerStatus[]>;
        update: (config: MossMcpServerInput) => Promise<McpServerStatus[]>;
        remove: (id: string) => Promise<McpServerStatus[]>;
        servers: () => Promise<MossMcpServerInput[]>;
        reconnect: (id: string) => Promise<McpServerStatus[]>;
      };
      shell: {
        openExternal: (url: string) => Promise<boolean>;
      };
      clipboard: {
        write: (text: string, html?: string) => Promise<boolean>;
      };
      stt: {
        transcribe: (request: TranscribeRequest) => Promise<TranscribeResult>;
      };
      checkpoint: {
        list: (turnId: string) => Promise<CheckpointFile[]>;
        revert: (turnId: string) => Promise<CheckpointRevertResult>;
      };
      codebase: {
        reindex: (workspaceRoot: string, config: EmbedConfig) => Promise<CodebaseReindexResult>;
        status: (workspaceRoot: string) => Promise<CodebaseStatus>;
      };
    };
  }
}

export {};
