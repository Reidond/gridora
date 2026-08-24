import type { SignedBackupWorkflowStep } from '@gridora/backup-workflow'

export const runBackupWorkflowSteps = async (
  operationType: 'backup-game-server' | 'restore-game-server',
  steps: readonly SignedBackupWorkflowStep['step'][],
  execute: (
    stepName: SignedBackupWorkflowStep['step'],
    ordinal: number,
    payload?: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>,
) => {
  if (operationType === 'restore-game-server') {
    let stageMayHaveStarted = false
    let terminalCommitted = false
    try {
      for (const [ordinal, stepName] of steps.entries()) {
        if (stepName === 'agent-restore-stage') stageMayHaveStarted = true
        await execute(stepName, ordinal)
        if (stepName === 'complete') terminalCommitted = true
      }
    } catch (cause) {
      if (stageMayHaveStarted && !terminalCommitted) {
        await execute('restore-rollback', 99)
        await execute('fail', 100, { terminal: true, compensated: true })
      }
      throw cause
    }
    return
  }
  for (const [ordinal, stepName] of steps.entries()) await execute(stepName, ordinal)
}
