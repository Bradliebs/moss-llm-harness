// electron/backend/moss/tools/index.ts

import type { ToolDefinition } from "../../../../common/types";
import { searchCodebaseTool } from "./codebase-tool";
import { editFileTool, globFilesTool, listDirTool, moveFileTool, readFileTool, searchFilesTool, writeFileTool } from "./fs-tools";
import { sendEmailTool } from "./email-tool";
import { GIT_TOOLS } from "./git-tools";
import { DELEGATE_TOOLS } from "./delegate-tool";
import { IMAGE_TOOLS } from "./image-tools";
import { planTool } from "./plan-tool";
import { workingStateTool } from "../governed/working-state";
import { SELF_TOOLS } from "./self-tools";
import { runCommandTool } from "./shell-tool";
import { transcribeAudioTool } from "./transcribe-tool";
import { readToolOutputTool } from "./tool-output-tool";
import type { Tool } from "./types";
import { fetchUrlTool, webSearchTool } from "./web-tools";

export const TOOLS: Tool[] = [
  planTool,
  workingStateTool,
  readFileTool,
  listDirTool,
  searchFilesTool,
  globFilesTool,
  searchCodebaseTool,
  readToolOutputTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  ...GIT_TOOLS,
  ...IMAGE_TOOLS,
  ...DELEGATE_TOOLS,
  runCommandTool,
  webSearchTool,
  fetchUrlTool,
  transcribeAudioTool,
  sendEmailTool,
  ...SELF_TOOLS,
];

export const TOOL_REGISTRY: Map<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

export type { Tool, ToolContext, ToolResult } from "./types";
