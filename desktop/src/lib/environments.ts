export type ExecutionEnvironment = 'local' | 'cloud'
export function executionBlockReason(environment: ExecutionEnvironment): string | undefined {
  return environment === 'cloud' ? 'Cloud is not configured. Choose Local to run this task on your Mac.' : undefined
}
