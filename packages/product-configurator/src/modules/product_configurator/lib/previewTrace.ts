import type { ConfigurationDefinition, Rule } from '../data/validators'
import type { StructureResult } from './evaluator/types'
import { sortByOrder } from './values'

export type FiredRule = { ruleId: string; label: string | null; effect: Rule['effect'] }

type TraceSource = Pick<StructureResult, 'forced' | 'errors' | 'warnings' | 'surcharges'>

/**
 * Rules that changed the result, in rule order: force rules that set a value, error and warning rules whose
 * condition holds, and surcharge rules whose BOM line is included. For the studio Test tab only.
 */
export function buildFiredRules(definition: ConfigurationDefinition, result: TraceSource): FiredRule[] {
  const fired = new Set<string>([
    ...result.forced.map((change) => change.ruleId),
    ...result.errors.flatMap((issue) => ('ruleId' in issue ? [issue.ruleId] : [])),
    ...result.warnings.map((issue) => issue.ruleId),
    ...result.surcharges.map((notice) => notice.ruleId),
  ])
  return sortByOrder(definition.rules)
    .filter((rule) => fired.has(rule.id))
    .map((rule) => ({ ruleId: rule.id, label: rule.label ?? null, effect: rule.effect }))
}
