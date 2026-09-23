// electron/preload.cjs
//
// Hand-written CommonJS preload (not compiled by tsc). Channel strings are
// duplicated from common/ipc-contract.ts — keep them in sync.

const { contextBridge, ipcRenderer } = require("electron");

const CH = {
  chatStart: "moss:chat:start",
  chatAbort: "moss:chat:abort",
  chatEvent: "moss:chat:event",
  toolApprove: "moss:tool:approve",
  chatSummarize: "moss:chat:summarize",
  taskCreate: "moss:task:create",
  taskList: "moss:task:list",
  taskGet: "moss:task:get",
  taskHistory: "moss:task:history",
  taskArtifactGet: "moss:task:artifact:get",
  taskStart: "moss:task:start",
  taskPause: "moss:task:pause",
  taskResume: "moss:task:resume",
  taskCancel: "moss:task:cancel",
  diagnosticsList: "moss:diagnostics:list",
  diagnosticsConfigure: "moss:diagnostics:configure",
  diagnosticsClear: "moss:diagnostics:clear",
  diagnosticsRecord: "moss:diagnostics:record",
  missionAuthorize: "moss:mission:authorize",
  missionCapabilities: "moss:mission:capabilities",
  providerListModels: "moss:provider:listModels",
  providerCredentialGet: "moss:provider:credentialGet",
  providerCredentialSet: "moss:provider:credentialSet",
  workspacePick: "moss:workspace:pick",
  workspacePreview: "moss:workspace:preview",
  workspaceSuggestVerification: "moss:workspace:suggestVerification",
  windowFocus: "moss:window:focus",
  memoryList: "moss:memory:list",
  memoryAdd: "moss:memory:add",
  memoryDelete: "moss:memory:delete",
  memoryClear: "moss:memory:clear",
  memoryReviewList: "moss:memory:reviewList",
  memoryReviewApprove: "moss:memory:reviewApprove",
  memoryReviewReject: "moss:memory:reviewReject",
  skillsList: "moss:skills:list",
  skillCreate: "moss:skills:create",
  skillDelete: "moss:skills:delete",
  skillToggle: "moss:skills:toggle",
  skillUpdate: "moss:skills:update",
  skillRename: "moss:skills:rename",
  skillImport: "moss:skills:import",
  mcpStatus: "moss:mcp:status",
  mcpSetEnabled: "moss:mcp:setEnabled",
  mcpOpenConfig: "moss:mcp:openConfig",
  mcpAddServer: "moss:mcp:addServer",
  mcpUpdateServer: "moss:mcp:updateServer",
  mcpRemoveServer: "moss:mcp:removeServer",
  mcpListConfigs: "moss:mcp:listConfigs",
  mcpReconnect: "moss:mcp:reconnect",
  shellOpenExternal: "moss:shell:openExternal",
  transcribe: "moss:stt:transcribe",
  clipboardWrite: "moss:clipboard:write",
  checkpointList: "moss:checkpoint:list",
  checkpointRevert: "moss:checkpoint:revert",
  codebaseReindex: "moss:codebase:reindex",
  codebaseStatus: "moss:codebase:status",
};

contextBridge.exposeInMainWorld("moss", {
  chat: {
    send: (request) => ipcRenderer.send(CH.chatStart, request),
    abort: (turnId) => ipcRenderer.send(CH.chatAbort, turnId),
    summarize: (request) => ipcRenderer.invoke(CH.chatSummarize, request),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on(CH.chatEvent, listener);
      return () => ipcRenderer.removeListener(CH.chatEvent, listener);
    },
  },
  tool: {
    approve: (decision) => ipcRenderer.send(CH.toolApprove, decision),
  },
  task: {
    create: (spec, id) => ipcRenderer.invoke(CH.taskCreate, spec, id),
    list: () => ipcRenderer.invoke(CH.taskList),
    get: (id) => ipcRenderer.invoke(CH.taskGet, id),
    history: (id) => ipcRenderer.invoke(CH.taskHistory, id),
    artifact: (taskId, artifactId) => ipcRenderer.invoke(CH.taskArtifactGet, taskId, artifactId),
    start: (id) => ipcRenderer.invoke(CH.taskStart, id),
    pause: (id, summary) => ipcRenderer.invoke(CH.taskPause, id, summary),
    resume: (id) => ipcRenderer.invoke(CH.taskResume, id),
    cancel: (id) => ipcRenderer.invoke(CH.taskCancel, id),
  },
  diagnostics: {
    list: () => ipcRenderer.invoke(CH.diagnosticsList),
    configure: (config) => ipcRenderer.invoke(CH.diagnosticsConfigure, config),
    clear: () => ipcRenderer.invoke(CH.diagnosticsClear),
    record: (kind) => ipcRenderer.invoke(CH.diagnosticsRecord, kind),
  },
  mission: {
    authorize: (request) => ipcRenderer.invoke(CH.missionAuthorize, request),
    capabilities: (request) => ipcRenderer.invoke(CH.missionCapabilities, request),
  },
  provider: {
    listModels: (config) => ipcRenderer.invoke(CH.providerListModels, config),
    getCredential: (providerId) => ipcRenderer.invoke(CH.providerCredentialGet, providerId),
    setCredential: (providerId, apiKey) => ipcRenderer.invoke(CH.providerCredentialSet, providerId, apiKey),
  },
  workspace: {
    pick: () => ipcRenderer.invoke(CH.workspacePick),
    preview: (root, path) => ipcRenderer.invoke(CH.workspacePreview, root, path),
    suggestVerification: (root) => ipcRenderer.invoke(CH.workspaceSuggestVerification, root),
  },
  window: {
    focus: () => ipcRenderer.invoke(CH.windowFocus),
  },
  memory: {
    list: () => ipcRenderer.invoke(CH.memoryList),
    add: (fact, category) => ipcRenderer.invoke(CH.memoryAdd, fact, category),
    delete: (id) => ipcRenderer.invoke(CH.memoryDelete, id),
    clear: () => ipcRenderer.invoke(CH.memoryClear),
    reviewList: () => ipcRenderer.invoke(CH.memoryReviewList),
    reviewApprove: (id) => ipcRenderer.invoke(CH.memoryReviewApprove, id),
    reviewReject: (id) => ipcRenderer.invoke(CH.memoryReviewReject, id),
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skillsList),
    create: (request) => ipcRenderer.invoke(CH.skillCreate, request),
    delete: (id) => ipcRenderer.invoke(CH.skillDelete, id),
    toggle: (id, enabled) => ipcRenderer.invoke(CH.skillToggle, id, enabled),
    update: (request) => ipcRenderer.invoke(CH.skillUpdate, request),
    rename: (request) => ipcRenderer.invoke(CH.skillRename, request),
    importFolder: () => ipcRenderer.invoke(CH.skillImport),
  },
  mcp: {
    status: () => ipcRenderer.invoke(CH.mcpStatus),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CH.mcpSetEnabled, id, enabled),
    openConfig: () => ipcRenderer.invoke(CH.mcpOpenConfig),
    add: (config) => ipcRenderer.invoke(CH.mcpAddServer, config),
    update: (config) => ipcRenderer.invoke(CH.mcpUpdateServer, config),
    remove: (id) => ipcRenderer.invoke(CH.mcpRemoveServer, id),
    servers: () => ipcRenderer.invoke(CH.mcpListConfigs),
    reconnect: (id) => ipcRenderer.invoke(CH.mcpReconnect, id),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(CH.shellOpenExternal, url),
  },
  clipboard: {
    write: (text, html) => ipcRenderer.invoke(CH.clipboardWrite, text, html),
  },
  stt: {
    transcribe: (request) => ipcRenderer.invoke(CH.transcribe, request),
  },
  checkpoint: {
    list: (turnId) => ipcRenderer.invoke(CH.checkpointList, turnId),
    revert: (turnId) => ipcRenderer.invoke(CH.checkpointRevert, turnId),
  },
  codebase: {
    reindex: (workspaceRoot, config) => ipcRenderer.invoke(CH.codebaseReindex, workspaceRoot, config),
    status: (workspaceRoot) => ipcRenderer.invoke(CH.codebaseStatus, workspaceRoot),
  },
});
