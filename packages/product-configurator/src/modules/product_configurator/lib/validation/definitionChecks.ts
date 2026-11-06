import type { Condition, Feature, Lookup } from '../../data/validators'
import type { DefinitionIndex } from '../evaluator/context'
import { forcedValueIssue, optionDomain, valueIssue } from '../evaluator/structure'
import { extractPlaceholders } from '../messages'
import { expressionReads } from './formulas'
import type { ValidationIssue, ValidationRef } from './types'

type Owner = { ref: ValidationRef; key: string }

function ownerOf(kind: 'feature' | 'formula' | 'rule' | 'bom' | 'lookup', key: string): Owner {
  return { ref: { kind, key }, key }
}

export function checkDuplicateKeys(index: DefinitionIndex): ValidationIssue[] {
  const { definition } = index
  const collections = [
    { collection: 'features', kind: 'feature', keys: definition.features.map((feature) => feature.key) },
    { collection: 'formulas', kind: 'formula', keys: definition.formulas.map((formula) => formula.key) },
    { collection: 'lookups', kind: 'lookup', keys: definition.lookups.map((lookup) => lookup.key) },
    { collection: 'bom', kind: 'bom', keys: definition.bom.map((line) => line.id) },
    { collection: 'rules', kind: 'rule', keys: definition.rules.map((rule) => rule.id) },
  ] as const
  const issues: ValidationIssue[] = []
  for (const { collection, kind, keys } of collections) {
    const seen = new Set<string>()
    const reported = new Set<string>()
    for (const key of keys) {
      if (seen.has(key) && !reported.has(key)) {
        reported.add(key)
        issues.push({ check: 'duplicate_key', code: 'duplicate_key', params: { collection, key }, refs: [{ kind, key }] })
      }
      seen.add(key)
    }
  }
  return issues
}

/** References inside the definition: features, formulas and lookups named by conditions, actions, features, lookups and BOM lines. */
export function checkReferentialIntegrity(index: DefinitionIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { definition } = index
  const reportedFeatures = new Set<string>()

  const requireFeature = (featureKey: string, owner: Owner) => {
    const signature = `${owner.ref.kind}\u0000${owner.key}\u0000${featureKey}`
    if (index.features.has(featureKey) || reportedFeatures.has(signature)) return
    reportedFeatures.add(signature)
    issues.push({ check: 'referential_integrity', code: 'unknown_feature', params: { featureKey, ownerKey: owner.key }, refs: [owner.ref] })
  }
  const requireFormula = (formulaKey: string, owner: Owner) => {
    if (index.formulas.has(formulaKey)) return
    issues.push({ check: 'referential_integrity', code: 'unknown_formula', params: { formulaKey, ownerKey: owner.key }, refs: [owner.ref] })
  }
  const requireLookup = (
    lookupKey: string,
    owner: Owner,
    expected: { kind?: Lookup['kind']; keyedBy?: string },
  ): void => {
    const lookup = index.lookups.get(lookupKey)
    const refs: ValidationRef[] = [owner.ref, { kind: 'lookup', key: lookupKey }]
    if (!lookup) {
      issues.push({ check: 'referential_integrity', code: 'unknown_lookup', params: { lookupKey, ownerKey: owner.key }, refs: [owner.ref] })
      return
    }
    if (expected.kind && lookup.kind !== expected.kind) {
      issues.push({
        check: 'referential_integrity',
        code: 'lookup_kind_mismatch',
        params: { lookupKey, expected: expected.kind, ownerKey: owner.key },
        refs,
      })
    }
    if (expected.keyedBy !== undefined && lookup.keyedBy !== expected.keyedBy) {
      issues.push({
        check: 'referential_integrity',
        code: 'lookup_keyed_by_mismatch',
        params: { lookupKey, keyedBy: expected.keyedBy, expected: lookup.keyedBy, ownerKey: owner.key },
        refs,
      })
    }
  }
  const checkConditions = (conditions: readonly Condition[] | undefined, owner: Owner) => {
    for (const condition of conditions ?? []) {
      if (condition.kind === 'calculated') {
        requireFormula(condition.formulaKey, owner)
        continue
      }
      requireFeature(condition.featureKey, owner)
      if (condition.kind === 'not_in_lookup') {
        requireFeature(condition.keyedBy, owner)
        requireLookup(condition.lookupKey, owner, { keyedBy: condition.keyedBy })
      }
    }
  }

  for (const feature of definition.features) {
    const owner = ownerOf('feature', feature.key)
    checkConditions(feature.visibleWhen, owner)
    if (feature.optionsFromLookup) requireLookup(feature.optionsFromLookup, owner, { kind: 'permitted' })
  }
  for (const lookup of definition.lookups) requireFeature(lookup.keyedBy, ownerOf('lookup', lookup.key))
  for (const rule of definition.rules) {
    const owner = ownerOf('rule', rule.id)
    checkConditions(rule.when, owner)
    rule.featureKeys.forEach((featureKey) => requireFeature(featureKey, owner))
    if (!rule.action) continue
    requireFeature(rule.action.featureKey, owner)
    if (rule.action.kind === 'lookup_default') {
      requireFeature(rule.action.keyedBy, owner)
      requireLookup(rule.action.lookupKey, owner, { kind: 'permitted', keyedBy: rule.action.keyedBy })
    }
  }
  for (const line of definition.bom) {
    const owner = ownerOf('bom', line.id)
    checkConditions(line.when, owner)
    if (typeof line.quantity !== 'number') requireFormula(line.quantity.formulaKey, owner)
    if (line.skuFromLookup) {
      requireFeature(line.skuFromLookup.keyedBy, owner)
      requireLookup(line.skuFromLookup.lookupKey, owner, { kind: 'value', keyedBy: line.skuFromLookup.keyedBy })
    }
  }
  return issues
}

function enumerableDomain(index: DefinitionIndex, feature: Feature): string[] | null {
  if (feature.type === 'boolean') return ['true', 'false']
  if (feature.type === 'number') return null
  return optionDomain(index, feature)
}

/**
 * Every value of a choice, color or boolean feature that keys a lookup has a row in it: SKU and permitted-options
 * lookups, and value lookups read by formulas (a missing row fails evaluation) or by `{lookup.<key>}` placeholders.
 */
export function checkLookupCoverage(index: DefinitionIndex): ValidationIssue[] {
  const usages: Array<{ lookupKey: string; owner: Owner; valueOnly?: boolean }> = []
  for (const line of index.definition.bom) {
    if (line.skuFromLookup) usages.push({ lookupKey: line.skuFromLookup.lookupKey, owner: ownerOf('bom', line.id) })
  }
  for (const feature of index.definition.features) {
    if (feature.optionsFromLookup) usages.push({ lookupKey: feature.optionsFromLookup, owner: ownerOf('feature', feature.key) })
  }
  for (const formula of index.definition.formulas) {
    for (const lookupKey of expressionReads(formula.expr).lookups) {
      usages.push({ lookupKey, owner: ownerOf('formula', formula.key), valueOnly: true })
    }
  }
  for (const rule of index.definition.rules) {
    for (const placeholder of extractPlaceholders(rule.messageTemplate)) {
      if (placeholder.kind === 'lookup') usages.push({ lookupKey: placeholder.key, owner: ownerOf('rule', rule.id), valueOnly: true })
    }
  }

  const issues: ValidationIssue[] = []
  const reported = new Set<string>()
  for (const { lookupKey, owner, valueOnly } of usages) {
    const lookup = index.lookups.get(lookupKey)
    const keyFeature = lookup ? index.features.get(lookup.keyedBy) : undefined
    if (!lookup || !keyFeature || (valueOnly && lookup.kind !== 'value')) continue
    const domain = enumerableDomain(index, keyFeature)
    if (!domain) continue
    const matches = new Set(lookup.rows.map((row) => row.match))
    for (const value of domain) {
      const signature = `${lookupKey}\u0000${value}`
      if (matches.has(value) || reported.has(signature)) continue
      reported.add(signature)
      issues.push({
        check: 'lookup_coverage',
        code: 'lookup_row_missing',
        params: { lookupKey, featureKey: keyFeature.key, value },
        refs: [{ kind: 'lookup', key: lookupKey }, owner.ref],
      })
    }
  }
  return issues
}

export function checkDefaults(index: DefinitionIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const feature of index.definition.features) {
    const reason = valueIssue(index, feature, feature.default)
    const refs = [{ kind: 'feature' as const, key: feature.key }]
    const params = { featureKey: feature.key, value: feature.default }
    if (reason === 'not_an_option') {
      issues.push({ check: 'default_valid', code: 'default_not_an_option', params, refs })
    } else if (reason === 'below_min' || reason === 'above_max') {
      issues.push({
        check: 'default_valid',
        code: 'default_out_of_bounds',
        params: { ...params, min: feature.min ?? null, max: feature.max ?? null },
        refs,
      })
    } else if (reason === 'step') {
      issues.push({ check: 'default_valid', code: 'default_off_step', params: { ...params, step: feature.step ?? null }, refs })
    }
  }
  return issues
}

/** Values a `set` or `map` action writes fit the target feature, so the rule can never fail every configuration. */
export function checkActionValues(index: DefinitionIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const rule of index.definition.rules) {
    const action = rule.action
    if (!action || action.kind === 'lookup_default') continue
    const feature = index.features.get(action.featureKey)
    if (!feature) continue
    const values = action.kind === 'set' ? [action.value] : [...new Set(Object.values(action.from))]
    for (const value of values) {
      if (!forcedValueIssue(index, feature, value)) continue
      issues.push({
        check: 'action_value',
        code: 'action_value_invalid',
        params: { ruleId: rule.id, featureKey: feature.key, value },
        refs: [{ kind: 'rule', key: rule.id }],
      })
    }
  }
  return issues
}

export function checkSurchargeBindings(index: DefinitionIndex): ValidationIssue[] {
  const rules = new Map(index.definition.rules.map((rule) => [rule.id, rule]))
  const linesByRule = new Map<string, string[]>()
  const issues: ValidationIssue[] = []
  for (const line of index.definition.bom) {
    if (line.ruleId === undefined) continue
    const rule = rules.get(line.ruleId)
    const refs: ValidationRef[] = [{ kind: 'bom', key: line.id }]
    if (!rule) {
      issues.push({ check: 'surcharge_binding', code: 'unknown_rule', params: { ruleId: line.ruleId, bomId: line.id }, refs })
      continue
    }
    if (rule.effect !== 'surcharge') {
      issues.push({
        check: 'surcharge_binding',
        code: 'surcharge_rule_expected',
        params: { ruleId: rule.id, bomId: line.id, effect: rule.effect },
        refs: [...refs, { kind: 'rule', key: rule.id }],
      })
      continue
    }
    linesByRule.set(rule.id, [...(linesByRule.get(rule.id) ?? []), line.id])
  }
  for (const [ruleId, bomIds] of linesByRule) {
    if (bomIds.length < 2) continue
    issues.push({
      check: 'surcharge_binding',
      code: 'surcharge_multiple_lines',
      params: { ruleId, bomIds },
      refs: [{ kind: 'rule', key: ruleId }, ...bomIds.map((bomId) => ({ kind: 'bom' as const, key: bomId }))],
    })
  }
  return issues
}

const PLACEHOLDER_SHAPED = /\{(?:feature|formula|lookup|line)\.[^{}]*(?:\}|$|(?=\{))/g

/**
 * Placeholders name existing keys. `{line.<bomId>.total}` is only filled for a surcharge notice of the
 * line bound to that rule, so anywhere else it would render as raw text.
 */
export function checkPlaceholders(index: DefinitionIndex): ValidationIssue[] {
  const bomLines = new Map(index.definition.bom.map((line) => [line.id, line]))
  const issues: ValidationIssue[] = []
  for (const rule of index.definition.rules) {
    const refs: ValidationRef[] = [{ kind: 'rule', key: rule.id }]
    const placeholders = extractPlaceholders(rule.messageTemplate)
    const valid = new Set(placeholders.map((placeholder) => placeholder.token))
    for (const token of rule.messageTemplate.match(PLACEHOLDER_SHAPED) ?? []) {
      if (!valid.has(token)) {
        issues.push({ check: 'placeholder_reference', code: 'placeholder_malformed', params: { ruleId: rule.id, token }, refs })
      }
    }
    for (const placeholder of placeholders) {
      const params = { ruleId: rule.id, token: placeholder.token }
      if (placeholder.kind === 'line') {
        const line = bomLines.get(placeholder.bomId)
        if (!line) {
          issues.push({ check: 'placeholder_reference', code: 'unknown_bom_line', params: { ...params, bomId: placeholder.bomId }, refs })
        } else if (rule.effect !== 'surcharge' || line.ruleId !== rule.id) {
          issues.push({
            check: 'placeholder_reference',
            code: 'placeholder_line_not_allowed',
            params: { ...params, bomId: placeholder.bomId },
            refs: [...refs, { kind: 'bom', key: line.id }],
          })
        }
        continue
      }
      if (placeholder.kind === 'feature' && !index.features.has(placeholder.key)) {
        issues.push({ check: 'placeholder_reference', code: 'unknown_feature', params: { ...params, featureKey: placeholder.key, ownerKey: rule.id }, refs })
      } else if (placeholder.kind === 'formula' && !index.formulas.has(placeholder.key)) {
        issues.push({ check: 'placeholder_reference', code: 'unknown_formula', params: { ...params, formulaKey: placeholder.key, ownerKey: rule.id }, refs })
      } else if (placeholder.kind === 'lookup' && !index.lookups.has(placeholder.key)) {
        issues.push({ check: 'placeholder_reference', code: 'unknown_lookup', params: { ...params, lookupKey: placeholder.key, ownerKey: rule.id }, refs })
      }
    }
  }
  return issues
}
