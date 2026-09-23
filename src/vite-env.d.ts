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
  ProviderConfig,
  ProductDiagnosticEntry,
  ProductDiagnosticsConfig,
  Skill,
  SkillCreateRequest,
  SkillImportResult,
  SkillUpdateRequest,
  SkillRenameRequest,
  TaskArtifactContent,
  TaskHistoryEntry,
  TaskSnapshot,
  TaskSpec,
  ToolApprovalDecision,
  TranscribeRequest,
  TranscribeResult,
} from "@common/types";

declare global {
  /** Server shape accepted by the settings UI add/edit form and returned by
   *  mcp.servers(). A structural subset of the backend McpServerConfig: only the
   *  fields the form reads or writes (env/cwd/headers stay file-edited). */
  type MossMcpServerInput =
    | { type: "stdio"; id: string; command: string; args?: string[]; enabled?: boolean }
    | { type: "http"; id: string; url: string; enabled?: boolean };


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
