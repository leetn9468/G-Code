/**
 * @file PlanModeTool.ts
 * @brief EnterPlanMode and ExitPlanMode tools
 *
 * Plan mode switches the agent to read-only: write tools are denied,
 * only exploration and planning tools are allowed.
 */

import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import type { Store } from '../../state/store.js'
import type { AppState, PermissionMode } from '../../types.js'

// ============================================================================
// Plan Mode State
// ============================================================================

let planModeStore: Store<AppState> | null = null
const previousModes = new Map<string, PermissionMode>()

export function setPlanModeStore(store: Store<AppState>): void {
  planModeStore = store
}

// ============================================================================
// EnterPlanMode
// ============================================================================

const enterInputSchema = z.object({})
type EnterInput = z.infer<typeof enterInputSchema>

export const EnterPlanModeTool: Tool<EnterInput, string> = {
  name: 'EnterPlanMode',
  description: 'Switch to plan mode for read-only exploration before implementing',
  inputSchema: enterInputSchema,

  async call(_input, context): Promise<ToolResult<string>> {
    if (!context.getPermissionContext && !planModeStore) {
      return { success: false, error: 'Plan mode store not initialized' }
    }

    const permissions = context.getPermissionContext?.() ?? planModeStore!.getState().permissionContext
    if (permissions.mode === 'plan') {
      return { success: false, error: 'Already in plan mode' }
    }

    previousModes.set(context.sessionId, permissions.mode)

    if (context.setPermissionMode) context.setPermissionMode('plan')
    else planModeStore!.setState((prev) => ({
      permissionContext: {
        ...prev.permissionContext,
        mode: 'plan' as PermissionMode,
      },
    }))

    return {
      success: true,
      output: 'Entered plan mode. Write tools are now disabled. Use ExitPlanMode when ready to implement.',
    }
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return { decision: 'allow' }
  },

  prompt(): string {
    return 'EnterPlanMode: Switch to read-only plan mode for exploration and design.'
  },
}

// ============================================================================
// ExitPlanMode
// ============================================================================

const exitInputSchema = z.object({})
type ExitInput = z.infer<typeof exitInputSchema>

export const ExitPlanModeTool: Tool<ExitInput, string> = {
  name: 'ExitPlanMode',
  description: 'Exit plan mode and return to normal execution',
  inputSchema: exitInputSchema,

  async call(_input, context): Promise<ToolResult<string>> {
    if (!context.getPermissionContext && !planModeStore) {
      return { success: false, error: 'Plan mode store not initialized' }
    }

    if ((context.getPermissionContext?.() ?? planModeStore!.getState().permissionContext).mode !== 'plan') {
      return { success: false, error: 'Not in plan mode' }
    }

    const previousMode = previousModes.get(context.sessionId) ?? 'default'
    if (context.setPermissionMode) context.setPermissionMode(previousMode)
    else planModeStore!.setState((prev) => ({
      permissionContext: {
        ...prev.permissionContext,
        mode: previousMode,
      },
    }))
    previousModes.delete(context.sessionId)

    return {
      success: true,
      output: `Exited plan mode. Returned to "${previousMode}" permission mode.`,
    }
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return { decision: 'allow' }
  },

  prompt(): string {
    return 'ExitPlanMode: Exit plan mode and return to normal execution with write access.'
  },
}
