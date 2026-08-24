import { describe, expect, it } from 'vitest'
import { runBackupWorkflowSteps } from '../src/backup-workflow-plan.js'

const restoreSteps = [
  'mark-running',
  'agent-restore-stage',
  'restore-validate',
  'restore-cutover',
  'complete',
  'restore-finalize',
] as const

describe('restore Workflow compensation', () => {
  it('runs the exact rollback before recording a terminal compensated failure', async () => {
    const calls: Array<{
      readonly step: string
      readonly ordinal: number
      readonly payload?: unknown
    }> = []
    await expect(
      runBackupWorkflowSteps(
        'restore-game-server',
        restoreSteps,
        async (step, ordinal, payload) => {
          calls.push({ step, ordinal, ...(payload === undefined ? {} : { payload }) })
          if (step === 'restore-validate') throw new Error('validation failed after staging')
        },
      ),
    ).rejects.toThrow('validation failed after staging')
    expect(calls).toEqual([
      { step: 'mark-running', ordinal: 0 },
      { step: 'agent-restore-stage', ordinal: 1 },
      { step: 'restore-validate', ordinal: 2 },
      { step: 'restore-rollback', ordinal: 99 },
      { step: 'fail', ordinal: 100, payload: { terminal: true, compensated: true } },
    ])
  })

  it('does not record terminal failure when compensation itself is unavailable', async () => {
    const calls: string[] = []
    await expect(
      runBackupWorkflowSteps('restore-game-server', restoreSteps, async (step) => {
        calls.push(step)
        if (step === 'restore-cutover') throw new Error('cutover failed')
        if (step === 'restore-rollback') throw new Error('rollback unavailable')
      }),
    ).rejects.toThrow('rollback unavailable')
    expect(calls).not.toContain('fail')
  })

  it('never rolls a terminally committed restore back when final cleanup must retry', async () => {
    const calls: string[] = []
    await expect(
      runBackupWorkflowSteps('restore-game-server', restoreSteps, async (step) => {
        calls.push(step)
        if (step === 'restore-finalize') throw new Error('finalize must retry')
      }),
    ).rejects.toThrow('finalize must retry')
    expect(calls).not.toContain('restore-rollback')
    expect(calls).not.toContain('fail')
  })
})
