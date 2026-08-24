import type { PluginBundle } from '@gridora/plugin-sdk'
export interface SchemaField {
  readonly path: string
  readonly label: string
  readonly kind: 'text' | 'number' | 'boolean' | 'select' | 'secret-reference'
  readonly required: boolean
  readonly help?: string
  readonly options?: readonly { readonly label: string; readonly value: string }[]
}
export interface UiContribution {
  readonly id: string
  readonly title: string
  readonly routeSuffix?: string
  readonly componentExport?: string
  readonly requiredCapability: string
}
export interface UiFacet {
  readonly fields: readonly SchemaField[]
  readonly contributions: readonly UiContribution[]
}
export interface UiPlugin extends PluginBundle {
  readonly ui: UiFacet
}
export const defineUiRegistry = <T extends UiPlugin>(
  plugins: readonly T[],
): ReadonlyMap<string, T['ui']> =>
  new Map(plugins.map((p) => [`${p.manifest.id}@${p.manifest.version}`, p.ui]))
