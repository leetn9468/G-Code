import type { InferenceMetrics } from '../../../src/shared/runtimeEvents'

/** The local model's generation speed for the status strip, and whether it is being measured now. */
export interface GenerationSpeed { tokensPerSecond: number; live: boolean }

/**
 * The speed after one reading of the local server's counters. A reading with a speed is live while
 * the model writes. Any other reading (prompt processing, a tool running between replies, idle)
 * keeps the last speed, held, so the strip does not blank between the replies of a turn.
 */
export function nextGenerationSpeed(previous: GenerationSpeed | null, metrics: InferenceMetrics): GenerationSpeed | null {
  const value = metrics.tokensPerSecond
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return { tokensPerSecond: value, live: metrics.processing }
  // The same object when nothing changes: idle readings arrive twice a second.
  return previous && (previous.live ? { ...previous, live: false } : previous)
}

/** "51.4 tk/s"; from 100 on, whole numbers. */
export function formatGenerationSpeed(value: number): string {
  const tenths = Math.round(value * 10) / 10
  return tenths < 100 ? `${tenths.toFixed(1)} tk/s` : `${Math.round(value)} tk/s`
}
