import type { Plugin } from '../types/gridora'
import { Schema } from 'effect'
import { ServerApplyIntent } from '@gridora/server-plan-control'
import type { ServerApplyRequest } from './gridora-api'

export class ServerApplyDraftError extends Error {}

export interface ServerApplyDraft {
  readonly name: string
  readonly pluginId: string
  readonly placementMode: 'auto' | 'shared' | 'dedicated'
  readonly cpuCores: number
  readonly memoryMiB: number
  readonly diskGiB: number
  readonly domain: string
  readonly configJson: string
  readonly modsJson: string
  readonly includeMods: boolean
  readonly nonHourlyCommitmentConfirmed: boolean
  /** Opaque server-issued proof for a review-bound commercial offer. */
  readonly commercialReviewToken?: string
}

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ServerApplyDraftError(`${field} must be a JSON object`)
  return value as Record<string, unknown>
}

const asFiniteInteger = (value: number, field: string, minimum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new ServerApplyDraftError(`${field} must be a whole number of at least ${minimum}`)
  return value
}

const parseJson = (source: string, field: string): unknown => {
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new ServerApplyDraftError(`${field} must contain valid JSON`)
  }
}

const parseMods = (source: string) => {
  const value = parseJson(source, 'Mods')
  if (!Array.isArray(value)) throw new ServerApplyDraftError('Mods must be a JSON array')
  return value
}

/** The core console only sends generic plugin-contract fields. Plugin-specific
 * configuration is a schema-owned JSON document, never a game-name switch. */
export const buildServerApplyRequest = (draft: ServerApplyDraft): ServerApplyRequest => {
  const cpuCores = asFiniteInteger(draft.cpuCores, 'CPU cores', 1)
  const memoryMiB = asFiniteInteger(draft.memoryMiB, 'Memory (MiB)', 128)
  const diskGiB = asFiniteInteger(draft.diskGiB, 'Disk (GiB)', 1)
  const cpuMillis = cpuCores * 1_000
  const ramBytes = memoryMiB * 1_024 * 1_024
  const diskBytes = diskGiB * 1_024 * 1_024 * 1_024
  if (
    !Number.isSafeInteger(cpuMillis) ||
    !Number.isSafeInteger(ramBytes) ||
    !Number.isSafeInteger(diskBytes)
  )
    throw new ServerApplyDraftError('Resource values exceed the supported exact range')
  const name = draft.name.trim()
  const pluginId = draft.pluginId.trim()
  if (name.length === 0) throw new ServerApplyDraftError('Server name is required')
  if (pluginId.length === 0) throw new ServerApplyDraftError('Choose a reviewed plugin')
  const domain = draft.domain.trim()
  const candidate = {
    schemaVersion: 1,
    server: {
      schemaVersion: 1,
      name,
      pluginId,
      placementMode: draft.placementMode,
      resources: { cpuMillis, ramBytes, diskBytes },
      nonHourlyCommitmentConfirmed: draft.nonHourlyCommitmentConfirmed,
    },
    game: {
      schemaVersion: 1,
      name,
      pluginId,
      // Auto is intentionally node-less. The durable parent only supplies a
      // node after authoritative capacity readiness is recorded.
      placement: { mode: draft.placementMode === 'auto' ? 'shared' : draft.placementMode },
      resources: { cpu: cpuCores, memoryMiB, diskGiB },
      config: asRecord(parseJson(draft.configJson, 'Plugin configuration'), 'Plugin configuration'),
      mods: draft.includeMods ? parseMods(draft.modsJson) : [],
      ...(domain.length === 0 ? {} : { domain }),
    },
    ...(draft.commercialReviewToken === undefined
      ? {}
      : { commercialReviewToken: draft.commercialReviewToken }),
  }
  try {
    // Do not trust UI parsing alone: use the same canonical contract which
    // backs the generated API client before a request leaves the browser.
    return Schema.decodeUnknownSync(ServerApplyIntent, { onExcessProperty: 'error' })(candidate)
  } catch {
    throw new ServerApplyDraftError(
      'Configuration, mod references, placement, or resources do not match the server apply contract',
    )
  }
}

export const pluginSupports = (plugin: Plugin | undefined, capability: string) =>
  plugin?.capabilities.some((item) => item.toLowerCase() === capability.toLowerCase()) ?? false

/** The UI asks for commercial acknowledgement only when the reviewed offer is non-hourly. */
export const requiresNonHourlyCommitmentConfirmation = (
  plan: {
    readonly kind: string
    readonly requiresNonHourlyCommitmentConfirmation?: boolean
    readonly billing?: { readonly billingCadence: 'hourly' | 'monthly' | 'contract' }
  } | null,
) => {
  const cadence = plan?.billing?.billingCadence
  return (
    plan?.kind === 'provision-node' &&
    (cadence === 'monthly' || cadence === 'contract') &&
    plan.requiresNonHourlyCommitmentConfirmation === true
  )
}

/** A reviewed non-hourly offer carries opaque consent proof only when policy requires it. */
export const requiresCommercialOfferReview = (
  plan: {
    readonly kind: string
    readonly commercialConsentRequired?: boolean
    readonly billing?: { readonly billingCadence: 'hourly' | 'monthly' | 'contract' }
  } | null,
) =>
  plan?.kind === 'provision-node' &&
  plan.billing?.billingCadence !== 'hourly' &&
  plan.commercialConsentRequired === true

/** Exact reviewed provider terms shown before an apply mutation is submitted. */
export const describeReviewedBillingTerms = (billing: {
  readonly billingCadence: 'hourly' | 'monthly' | 'contract'
  readonly contractMonths: number
}) => {
  if (billing.billingCadence === 'hourly') return 'Hourly billing · no term commitment'
  if (billing.billingCadence === 'monthly')
    return `Monthly billing · ${billing.contractMonths}-month commitment`
  return `${billing.contractMonths}-month provider contract`
}
