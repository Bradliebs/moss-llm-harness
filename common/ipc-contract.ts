// common/ipc-contract.ts
//
// Single source of truth for IPC channel names. The hand-written
// `electron/preload.cjs` cannot import this TS module, so it duplicates these
// string literals — keep the two in sync.

export const IPC = {
  /** renderer -> main: begin streaming a turn (fire-and-forget; events stream back) */
  chatStart: "moss:chat:start",
  /** renderer -> main: abort an in-flight turn by turnId */
  chatAbort: "moss:chat:abort",
  /** main -> renderer: a normalized MossEvent for a turn */
  chatEvent: "moss:chat:event",
  /** renderer -> main: approve or deny a pending tool call */
  toolApprove: "moss:tool:approve",
  /** renderer -> main (invoke): write a handoff summary of a conversation so it
   *  can be continued in a fresh chat; returns HandoffSummaryResult */
  chatSummarize: "moss:chat:summarize",
  /** renderer -> main (invoke): durable task lifecycle */
  taskCreate: "moss:task:create",
  taskList: "moss:task:list",
  taskGet: "moss:task:get",
  taskHistory: "moss:task:history",
  taskArtifactGet: "moss:task:artifact:get",
  taskStart: "moss:task:start",
  taskPause: "moss:task:pause",
  taskResume: "moss:task:resume",
  taskCancel: "moss:task:cancel",
  /** renderer -> main (invoke): native-confirm elevated mission authority */
  missionAuthorize: "moss:mission:authorize",
  /** renderer -> main (invoke): list currently eligible mission capabilities */
  missionCapabilities: "moss:mission:capabilities",
  /** renderer -> main (invoke): list available models for a provider config */
  providerListModels: "moss:provider:listModels",
  /** renderer -> main (invoke): read/write an OS-encrypted provider API key */
  providerCredentialGet: "moss:provider:credentialGet",
  providerCredentialSet: "moss:provider:credentialSet",
  /** renderer -> main (invoke): open a folder picker, returns path or null */
  workspacePick: "moss:workspace:pick",

  /** renderer -> main (invoke): memory CRUD */
  memoryList: "moss:memory:list",
  memoryAdd: "moss:memory:add",
  memoryDelete: "moss:memory:delete",
  memoryClear: "moss:memory:clear",
  /** renderer -> main (invoke): human-gated memory-write review queue */
  memoryReviewList: "moss:memory:reviewList",
  memoryReviewApprove: "moss:memory:reviewApprove",
  memoryReviewReject: "moss:memory:reviewReject",

  /** renderer -> main (invoke): skills CRUD */
  skillsList: "moss:skills:list",
  skillCreate: "moss:skills:create",
  skillDelete: "moss:skills:delete",
  skillToggle: "moss:skills:toggle",
  skillUpdate: "moss:skills:update",
  skillRename: "moss:skills:rename",
  skillImport: "moss:skills:import",

  /** renderer -> main (invoke): connected/failed status of MCP servers */
  mcpStatus: "moss:mcp:status",
  /** renderer -> main (invoke): enable/disable a configured MCP server, then
   *  re-init the manager and return the refreshed status */
  mcpSetEnabled: "moss:mcp:setEnabled",
  /** renderer -> main (invoke): open mcp-servers.json in the OS default editor */
  mcpOpenConfig: "moss:mcp:openConfig",
  /** renderer -> main (invoke): add a server to mcp-servers.json, then re-init
   *  the manager and return the refreshed status */
  mcpAddServer: "moss:mcp:addServer",
  /** renderer -> main (invoke): merge changed fields into an existing server in
   *  mcp-servers.json, then re-init the manager and return the refreshed status */
  mcpUpdateServer: "moss:mcp:updateServer",
  /** renderer -> main (invoke): remove a server from mcp-servers.json, then
   *  re-init the manager and return the refreshed status */
  mcpRemoveServer: "moss:mcp:removeServer",
  /** renderer -> main (invoke): read the raw configured servers, so the settings
   *  UI can populate an edit form with a server's command/args/url */
  mcpListConfigs: "moss:mcp:listConfigs",
  /** renderer -> main (invoke): tear down and reconnect a single server by id,
   *  then return the refreshed status */
  mcpReconnect: "moss:mcp:reconnect",

  /** renderer -> main (invoke): open an http(s)/mailto URL in the OS browser */
  shellOpenExternal: "moss:shell:openExternal",

  /** renderer -> main (invoke): transcribe captured audio to text (Whisper) */
  transcribe: "moss:stt:transcribe",

  /** renderer -> main (invoke): write text (and optional html) to the clipboard.
   *  Routed through main because the clipboard module is unavailable in the
   *  sandboxed preload. */
  clipboardWrite: "moss:clipboard:write",

  /** renderer -> main (invoke): list the files a turn changed, for the revert
   *  affordance; returns CheckpointFile[] (empty when the turn changed nothing) */
  checkpointList: "moss:checkpoint:list",
  /** renderer -> main (invoke): revert a turn's file changes by turnId */
  checkpointRevert: "moss:checkpoint:revert",

  /** renderer -> main (invoke): (re)build the semantic codebase index for a
   *  workspace with the given embeddings config; returns CodebaseReindexResult */
  codebaseReindex: "moss:codebase:reindex",
  /** renderer -> main (invoke): current index stats for a workspace */
  codebaseStatus: "moss:codebase:status",
} as const;
