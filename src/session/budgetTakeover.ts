import { abortActiveQueries, settleActiveQueries } from '../engine/queryEngine.js'
import { workflowTasks } from '../workflow/tasks.js'
import { backgroundShells } from '../tools/backgroundShells.js'
import { saveSession, type Store } from '../state/store.js'
import type { AppState } from '../types.js'

/** A same-process takeover must not leave the old stage's work running beside its replacement. */
export async function prepareBudgetTakeover(store: Store<AppState>): Promise<void> {
  abortActiveQueries()
  await workflowTasks.shutdown(store.getState().sessionId)
  await backgroundShells.stopAll()
  if (!await settleActiveQueries()) throw new Error('Previous session work has not settled. The handoff is saved; resume it explicitly after that work stops.')
  saveSession(store.getState(), { force: true })
}
