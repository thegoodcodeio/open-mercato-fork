import type { Condition, Feature, SelectionValue } from '../../data/validators'
import type { DefinitionIndex } from '../evaluator/context'
import { ConfiguratorEvaluationError } from '../evaluator/errors'
import { optionDomain, settle, valueIssue } from '../evaluator/structure'
import { sortByOrder, toFiniteNumber, type Selections } from '../values'
import { formulaFeatureReads } from './formulas'
import type { ValidationIssue } from './types'

const compareCodePoints = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const FIXED_POINT_MAX_RUNS = 512

/**
 * Runs the evaluator's own settle step over the selections that can influence settling, so the check
 * agrees with runtime by construction (pass limit, rule order, visibility resets, `calculated` reads).
 * Only features read by `force` rules or `visibleWhen`, and the features those write, are varied.
 * When their combinations fit in FIXED_POINT_MAX_RUNS the search is exhaustive; otherwise it covers
 * the defaults, every single-feature change and a few mixed combinations.
 */
export function checkFixedPoint(index: DefinitionIndex): ValidationIssue[] {
  const features = sortByOrder(index.definition.features)
  const relevant = settleRelevantFeatures(index)
  if (relevant.length === 0) return []

  const domains = relevant.map((feature) => ({ key: feature.key, values: candidateValues(index, feature) }))
  const defaults: Selections = {}
  for (const feature of features) defaults[feature.key] = feature.default

  const groups: Array<{ ruleIds: Set<string>; featureKeys: Set<string> }> = []
  for (const combination of combinations(domains)) {
    try {
      settle(index, features, { ...defaults, ...combination })
    } catch (error) {
      if (!(error instanceof ConfiguratorEvaluationError)) throw error
      if (error.code !== 'fixed_point_not_reached') continue
      mergeGroup(groups, stringList(error.params.ruleIds), stringList(error.params.featureKeys))
    }
  }
  return groups.map((group) => {
    const ruleIds = [...group.ruleIds].sort(compareCodePoints)
    const featureKeys = [...group.featureKeys].sort(compareCodePoints)
    return {
      check: 'fixed_point',
      code: 'fixed_point_not_reached',
      params: { ruleIds, featureKeys },
      refs: [
        ...ruleIds.map((ruleId) => ({ kind: 'rule' as const, key: ruleId })),
        ...featureKeys.map((featureKey) => ({ kind: 'feature' as const, key: featureKey })),
      ],
    }
  })
}

/** The evaluator names only what changed in the last pass, so failures that share a feature are one problem. */
function mergeGroup(
  groups: Array<{ ruleIds: Set<string>; featureKeys: Set<string> }>,
  ruleIds: string[],
  featureKeys: string[],
): void {
  const merged = { ruleIds: new Set(ruleIds), featureKeys: new Set(featureKeys) }
  for (let position = groups.length - 1; position >= 0; position -= 1) {
    const group = groups[position]
    if (![...group.featureKeys].some((key) => merged.featureKeys.has(key))) continue
    group.ruleIds.forEach((ruleId) => merged.ruleIds.add(ruleId))
    group.featureKeys.forEach((key) => merged.featureKeys.add(key))
    groups.splice(position, 1)
  }
  groups.push(merged)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function settleRelevantFeatures(index: DefinitionIndex): Feature[] {
  const keys = new Set<string>()
  const addConditionReads = (conditions: readonly Condition[] | undefined) => {
    for (const condition of conditions ?? []) {
      if (condition.kind === 'calculated') {
        formulaFeatureReads(index, condition.formulaKey).forEach((key) => keys.add(key))
        continue
      }
      keys.add(condition.featureKey)
      if (condition.kind === 'not_in_lookup') keys.add(condition.keyedBy)
    }
  }
  for (const feature of index.definition.features) {
    if (!feature.visibleWhen?.length) continue
    keys.add(feature.key)
    addConditionReads(feature.visibleWhen)
  }
  for (const rule of index.definition.rules) {
    if (rule.effect !== 'force' || !rule.action) continue
    addConditionReads(rule.when)
    keys.add(rule.action.featureKey)
    if (rule.action.kind === 'lookup_default') keys.add(rule.action.keyedBy)
  }
  return index.definition.features.filter((feature) => keys.has(feature.key))
}

function candidateValues(index: DefinitionIndex, feature: Feature): SelectionValue[] {
  if (feature.type === 'boolean') return [false, true]
  if (feature.type !== 'number') {
    const domain = optionDomain(index, feature)
    return domain.length > 0 ? domain : [feature.default]
  }
  const step = feature.step ?? 1
  const candidates = new Set<number>([feature.default].filter((value): value is number => typeof value === 'number'))
  if (feature.min !== undefined) candidates.add(feature.min)
  if (feature.max !== undefined) candidates.add(feature.max)
  for (const threshold of numericThresholds(index, feature.key)) {
    candidates.add(threshold)
    candidates.add(threshold - step)
    candidates.add(threshold + step)
  }
  return [...candidates].filter((value) => valueIssue(index, feature, value) === null)
}

function numericThresholds(index: DefinitionIndex, featureKey: string): number[] {
  const thresholds: number[] = []
  const conditionLists = [
    ...index.definition.features.map((feature) => feature.visibleWhen ?? []),
    ...index.definition.rules.filter((rule) => rule.effect === 'force').map((rule) => rule.when),
  ]
  for (const condition of conditionLists.flat()) {
    if (condition.kind !== 'compare' || condition.featureKey !== featureKey) continue
    const value = toFiniteNumber(condition.value)
    if (value !== null) thresholds.push(value)
  }
  for (const rule of index.definition.rules) {
    if (rule.action?.kind !== 'set' || rule.action.featureKey !== featureKey) continue
    const value = toFiniteNumber(rule.action.value)
    if (value !== null) thresholds.push(value)
  }
  return thresholds
}

type Domain = { key: string; values: SelectionValue[] }

function combinations(domains: Domain[]): Selections[] {
  const total = domains.reduce((product, domain) => product * Math.max(domain.values.length, 1), 1)
  if (total <= FIXED_POINT_MAX_RUNS) return cartesian(domains)

  const runs: Selections[] = [{}]
  for (const domain of domains) {
    for (const value of domain.values) runs.push({ [domain.key]: value })
  }
  const widest = Math.max(...domains.map((domain) => domain.values.length))
  for (let offset = 0; offset < widest; offset += 1) {
    const mixed: Selections = {}
    domains.forEach((domain, position) => {
      if (domain.values.length > 0) mixed[domain.key] = domain.values[(offset + position) % domain.values.length]
    })
    runs.push(mixed)
  }
  return runs.slice(0, FIXED_POINT_MAX_RUNS)
}

function cartesian(domains: Domain[]): Selections[] {
  let runs: Selections[] = [{}]
  for (const domain of domains) {
    if (domain.values.length === 0) continue
    runs = runs.flatMap((run) => domain.values.map((value) => ({ ...run, [domain.key]: value })))
  }
  return runs
}
