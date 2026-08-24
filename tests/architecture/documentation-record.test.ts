import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const implementationPath = `${root}docs/implementation/step-by-step.md`
const implementation = readFileSync(implementationPath, 'utf8')
const adrDirectory = `${root}docs/adr`
const adrIndex = readFileSync(`${adrDirectory}/README.md`, 'utf8')
const adrRecords = readdirSync(adrDirectory).filter((name) => /^\d{4}-.+\.md$/.test(name))

const steps = [...implementation.matchAll(/^## Step (\d+): .+$/gm)].map((match, index, matches) => {
  const start = match.index
  const end = matches[index + 1]?.index ?? implementation.length
  return {
    number: Number(match[1]),
    title: match[0],
    body: implementation.slice(start, end),
  }
})

describe('ADR and STE record integrity', () => {
  it('keeps the implementation steps sequential and explicit', () => {
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.map((step) => step.number)).toEqual(
      Array.from({ length: steps.length }, (_, index) => index + 1),
    )
    for (const step of steps) {
      expect(step.body, `${step.title} needs one controlled status`).toMatch(
        /^- Status: (local|template|live-blocked|pending)$/m,
      )
      expect(step.body, `${step.title} needs an action`).toMatch(/^- Action: /m)
      expect(step.body, `${step.title} needs a decision`).toMatch(/^- Decision: /m)
      expect(step.body, `${step.title} must cite an ADR`).toMatch(/ADR \d{4}/)
      expect(
        /^- Evidence: /m.test(step.body) || /^- Blocker: /m.test(step.body),
        `${step.title} needs evidence or an explicit blocker`,
      ).toBe(true)
    }
  })

  it('resolves every ADR reference to a record', () => {
    const references = new Set(
      [...implementation.matchAll(/ADR (\d{4})/g)].map((match) => match[1] as string),
    )
    for (const id of references) {
      expect(
        adrRecords.some((record) => record.startsWith(`${id}-`)),
        `ADR ${id} is missing`,
      ).toBe(true)
    }
  })

  it('indexes every ADR and keeps each decision structure explicit', () => {
    for (const record of adrRecords) {
      const id = record.slice(0, 4)
      const body = readFileSync(`${adrDirectory}/${record}`, 'utf8')
      expect(adrIndex, `ADR ${id} is missing from the ADR index`).toMatch(
        new RegExp(`ADR ${id}\\b`),
      )
      expect(body, `${record} needs an accepted decision status`).toMatch(
        /^- Status: (Proposed|Accepted|Superseded|Rejected)$/m,
      )
      expect(body, `${record} needs a decision date`).toMatch(/^- Date: \d{4}-\d{2}-\d{2}$/m)
      const number = Number(id)
      const headings =
        number >= 29 || number === 24
          ? ['Situation', 'Task', 'Execution', 'Consequences', 'Verification']
          : ['Context', 'Decision', 'Consequences', 'Alternatives', 'Verification']
      for (const heading of headings) {
        expect(body, `${record} needs the ${heading} section`).toMatch(
          new RegExp(`^## ${heading}$`, 'm'),
        )
      }
    }
  })

  it('labels the record as pre-alpha and does not convert local evidence into a live claim', () => {
    expect(implementation).toContain('public pre-alpha implementation')
    expect(implementation).toContain('The status `local`')
    expect(implementation).toContain('does not mean that a live service used the code')
  })
})
