import { WorkflowTool } from '../workflow/WorkflowTool.js'
import { warnIgnoredProjectWorkflowSetting, workflowSettings } from '../workflow/settings.js'
/**
 * @file registry.ts
 * @brief Tool registry — manages built-in and dynamic tools
 */

import type { ToolPermissionContext } from '../types.js'
import { evaluatePermission } from './permissions.js'
import type { Tool, Tools } from './tool.js'
import { BashTool } from './impl/BashTool.js'
import { BrowserVerifyTool } from './impl/BrowserVerifyTool.js'
import { BrowserPlanTool, BrowserPlanCheckTool } from './impl/BrowserPlanTool.js'
import { FileReadTool } from './impl/FileReadTool.js'
import { FileWriteTool } from './impl/FileWriteTool.js'
import { FileEditTool } from './impl/FileEditTool.js'
import { GrepTool } from './impl/GrepTool.js'
import { GlobTool } from './impl/GlobTool.js'
import { ListDirTool } from './impl/ListDirTool.js'
import { WebFetchTool } from './impl/WebFetchTool.js'
import { WebSearchTool } from './impl/WebSearchTool.js'
import { TodoWriteTool } from './impl/TodoWriteTool.js'
import { TeamMemoryWriteTool } from './impl/TeamMemoryWriteTool.js'
import { EnterPlanModeTool, ExitPlanModeTool } from './impl/PlanModeTool.js'
import { AgentTool } from './impl/AgentTool.js'
import { NotebookEditTool } from './impl/NotebookEditTool.js'
import { LSPTool } from './impl/LSPTool.js'
import {
  TaskCreateTool, TaskGetTool, TaskListTool,
  TaskUpdateTool, TaskStopTool, TaskOutputTool,
} from './impl/TaskTools.js'
import { EnterWorktreeTool, ExitWorktreeTool } from './impl/WorktreeTools.js'
import { SleepTool, ConfigTool, ToolSearchTool, PowerShellTool } from './impl/UtilityTools.js'

// ============================================================================
// Built-in Tool Definitions
// ============================================================================

const BUILTIN_TOOLS: Array<Tool<unknown, unknown>> = [
  // Core file operations
  BashTool as Tool<unknown, unknown>,
  FileReadTool as Tool<unknown, unknown>,
  FileWriteTool as Tool<unknown, unknown>,
  FileEditTool as Tool<unknown, unknown>,
  GrepTool as Tool<unknown, unknown>,
  GlobTool as Tool<unknown, unknown>,
  ListDirTool as Tool<unknown, unknown>,

  // Web
  WebFetchTool as Tool<unknown, unknown>,
  WebSearchTool as Tool<unknown, unknown>,
  BrowserVerifyTool as Tool<unknown, unknown>,
  BrowserPlanTool as Tool<unknown, unknown>,
  BrowserPlanCheckTool as Tool<unknown, unknown>,

  // User interaction
  TodoWriteTool as Tool<unknown, unknown>,

  // Memory
  TeamMemoryWriteTool as Tool<unknown, unknown>,

  // Plan mode
  EnterPlanModeTool as Tool<unknown, unknown>,
  ExitPlanModeTool as Tool<unknown, unknown>,

  // Agents
  AgentTool as Tool<unknown, unknown>,

  // Code intelligence
  NotebookEditTool as Tool<unknown, unknown>,
  LSPTool as Tool<unknown, unknown>,

  // Background tasks
  TaskCreateTool as Tool<unknown, unknown>,
  TaskGetTool as Tool<unknown, unknown>,
  TaskListTool as Tool<unknown, unknown>,
  TaskUpdateTool as Tool<unknown, unknown>,
  TaskStopTool as Tool<unknown, unknown>,
  TaskOutputTool as Tool<unknown, unknown>,

  // Git worktrees
  EnterWorktreeTool as Tool<unknown, unknown>,
  ExitWorktreeTool as Tool<unknown, unknown>,

  // Utilities
  SleepTool as Tool<unknown, unknown>,
  ConfigTool as Tool<unknown, unknown>,
  ToolSearchTool as Tool<unknown, unknown>,
  // PowerShell is Windows-only; skip registration on other platforms so it
  // doesn't appear in the tool catalog with an always-erroring call().
  ...(process.platform === 'win32' ? [PowerShellTool as Tool<unknown, unknown>] : []),
]

// ============================================================================
// Registry
// ============================================================================

const dynamicTools: Array<Tool<unknown, unknown>> = []

export function registerTool(tool: Tool<unknown, unknown>): void {
  dynamicTools.push(tool)
}

export function unregisterTool(name: string): void {
  const idx = dynamicTools.findIndex((t) => t.name === name)
  if (idx >= 0) dynamicTools.splice(idx, 1)
}

export function getTools(permissionContext: ToolPermissionContext, cwd = process.cwd()): Tools {
  // Workflow registers from personal settings only; say so when a project tries to set it.
  warnIgnoredProjectWorkflowSetting(cwd)
  const all = [...BUILTIN_TOOLS, ...(workflowSettings(cwd).enabled ? [WorkflowTool as Tool] : []), ...dynamicTools]

  return all.filter((tool) => {
    // Mode can change during a query (EnterPlanMode/ExitPlanMode). Keep the
    // catalog stable and enforce its live mode immediately before each call.
    const perm = evaluatePermission(tool.name, { ...permissionContext, mode: 'default' })
    return perm.decision !== 'deny'
  })
}

export function findTool(name: string): Tool<unknown, unknown> | undefined {
  if (name === 'Workflow') return workflowSettings(process.cwd()).enabled ? WorkflowTool as Tool : undefined
  return BUILTIN_TOOLS.find((t) => t.name === name)
    ?? dynamicTools.find((t) => t.name === name)
}
