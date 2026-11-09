import type { ValidationIssue, ValidationRef } from '../../lib/validation/types'
import type { StudioDefinition, StudioIssue, StudioTabId } from './tabs/types'

export type StudioRefTarget = { tab: StudioTabId; key: string | null }

const REF_KIND_TABS: Record<Exclude<ValidationRef['kind'], 'path'>, StudioTabId> = {
  feature: 'features',
  formula: 'formulas',
  lookup: 'lookups',
  rule: 'rules',
  bom: 'bom',
  product: 'overview',
  priceKind: 'overview',
}

const ROW_KEYS = new Set(['product', 'priceKind'])

function keyAt(definition: StudioDefinition | null, section: string, index: number): string | null {
  if (!definition || !Number.isInteger(index)) return null
  switch (section) {
    case 'features':
      return definition.features[index]?.key ?? null
    case 'formulas':
      return definition.formulas[index]?.key ?? null
    case 'lookups':
      return definition.lookups[index]?.key ?? null
    case 'rules':
      return definition.rules[index]?.id ?? null
    case 'bom':
      return definition.bom[index]?.id ?? null
    default:
      return null
  }
}

function pathTarget(path: string, definition: StudioDefinition | null): StudioRefTarget {
  const [section, rawIndex] = path.split('.')
  if (section === 'features' || section === 'formulas' || section === 'lookups' || section === 'rules' || section === 'bom') {
    return { tab: section, key: rawIndex === undefined ? null : keyAt(definition, section, Number(rawIndex)) }
  }
  if (section === 'commercial') return { tab: 'overview', key: null }
  return { tab: 'advanced', key: null }
}

/** Where a report reference points in the studio. Path refs resolve their row index against `definition` (the saved draft). */
export function resolveRefTarget(ref: ValidationRef, definition: StudioDefinition | null): StudioRefTarget {
  if (ref.kind === 'path') return pathTarget(ref.path, definition)
  return { tab: REF_KIND_TABS[ref.kind], key: ROW_KEYS.has(ref.kind) ? null : ref.key }
}

/** Unique targets of one issue, in the order of its refs. */
export function issueTargets(issue: ValidationIssue, definition: StudioDefinition | null): StudioRefTarget[] {
  const targets: StudioRefTarget[] = []
  for (const ref of issue.refs) {
    const target = resolveRefTarget(ref, definition)
    if (!targets.some((entry) => entry.tab === target.tab && entry.key === target.key)) targets.push(target)
  }
  return targets
}

/** Issues grouped by the tab they point at; an issue with refs to two tabs appears in both. */
export function groupIssuesByTab(
  issues: readonly ValidationIssue[],
  definition: StudioDefinition | null,
): Partial<Record<StudioTabId, StudioIssue[]>> {
  const grouped: Partial<Record<StudioTabId, StudioIssue[]>> = {}
  for (const issue of issues) {
    for (const target of issueTargets(issue, definition)) {
      const bucket = grouped[target.tab] ?? []
      bucket.push({ issue, key: target.key })
      grouped[target.tab] = bucket
    }
    if (issue.check === 'formula_cycle' || issue.check === 'fixed_point') {
      const dependencies = grouped.dependencies ?? []
      dependencies.push({ issue, key: null })
      grouped.dependencies = dependencies
    }
  }
  return grouped
}
