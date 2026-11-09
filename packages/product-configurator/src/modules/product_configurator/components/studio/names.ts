import type { StudioDefinition } from './tabs/types'

/** "Engine power (engine_power)", or just the key when there is no separate label. */
export function friendlyName(label: string | undefined, key: string): string {
  return label && label !== key ? `${label} (${key})` : key
}

export function featureName(definition: StudioDefinition | null, key: string): string {
  return friendlyName(definition?.features.find((feature) => feature.key === key)?.label, key)
}

export function formulaName(definition: StudioDefinition | null, key: string): string {
  return friendlyName(definition?.formulas.find((formula) => formula.key === key)?.label, key)
}

export function lookupName(definition: StudioDefinition | null, key: string): string {
  return friendlyName(definition?.lookups.find((lookup) => lookup.key === key)?.label, key)
}

export function ruleName(definition: StudioDefinition | null, id: string): string {
  return friendlyName(definition?.rules.find((rule) => rule.id === id)?.label, id)
}

/** Any key or id: features first, then formulas, lookups and rules (BOM lines have no label). */
export function anyName(definition: StudioDefinition | null, key: string): string {
  if (!definition) return key
  const label =
    definition.features.find((feature) => feature.key === key)?.label ??
    definition.formulas.find((formula) => formula.key === key)?.label ??
    definition.lookups.find((lookup) => lookup.key === key)?.label ??
    definition.rules.find((rule) => rule.id === key)?.label
  return friendlyName(label, key)
}
