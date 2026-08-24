#!/usr/bin/env node
import { Effect } from 'effect'
import { runNodeCli } from './node-runtime.js'

Effect.runPromise(
  Effect.tryPromise({ try: () => runNodeCli(process.argv.slice(2)), catch: (cause) => cause }),
).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    process.stderr.write(`gridora failed: ${String(error)}\n`)
    process.exitCode = 10
  },
)
