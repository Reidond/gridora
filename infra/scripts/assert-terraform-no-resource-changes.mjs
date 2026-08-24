#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const planPath = process.argv[2]
if (planPath === undefined || process.argv.length !== 3) {
  process.stderr.write(
    'usage: node infra/scripts/assert-terraform-no-resource-changes.mjs <plan.json>\n',
  )
  process.exit(2)
}

let plan
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8'))
} catch (error) {
  const detail = error instanceof Error ? error.message : 'unknown read error'
  process.stderr.write(`Terraform plan assertion failed: cannot read ${planPath}: ${detail}\n`)
  process.exit(2)
}

const changes = Array.isArray(plan.resource_changes) ? plan.resource_changes : []
const material = changes.filter((change) => {
  const actions = change?.change?.actions
  return Array.isArray(actions) && actions.some((action) => action !== 'no-op')
})

if (material.length > 0) {
  process.stderr.write(
    'Terraform plan assertion failed: default validation must not change resources.\n',
  )
  for (const change of material) {
    const address = typeof change.address === 'string' ? change.address : '<unknown resource>'
    const actions = Array.isArray(change?.change?.actions)
      ? change.change.actions.join(',')
      : 'unknown'
    process.stderr.write(`- ${address}: ${actions}\n`)
  }
  process.exit(1)
}

process.stdout.write('Terraform default plan has no resource changes.\n')
