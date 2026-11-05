import type { ConfigurationDefinition, Expression } from '../../data/validators'
import type { DefinitionIndex } from '../evaluator/context'
import { optionDomain } from '../evaluator/structure'
import { toFiniteNumber } from '../values'
import type { ValidationIssue } from './types'

export type ExpressionReads = { features: Set<string>; formulas: Set<string>; lookups: Set<string> }

export function expressionReads(expression: Expression): ExpressionReads {
  const reads: ExpressionReads = { features: new Set(), formulas: new Set(), lookups: new Set() }
  const pending: Expression[] = [expression]
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.kind === 'feature') reads.features.add(node.featureKey)
    else if (node.kind === 'formula') reads.formulas.add(node.formulaKey)
    else if (node.kind === 'lookup') reads.lookups.add(node.lookupKey)
    else if (node.kind === 'op') pending.push(node.right, node.left)
  }
  return reads
}

/** Features a formula reads directly, through other formulas, and through the `keyedBy` of the lookups it reads. */
export function formulaFeatureReads(index: DefinitionIndex, formulaKey: string): Set<string> {
  const features = new Set<string>()
  const visited = new Set<string>()
  const pending = [formulaKey]
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (visited.has(key)) continue
    visited.add(key)
    const formula = index.formulas.get(key)
    if (!formula) continue
    const reads = expressionReads(formula.expr)
    reads.features.forEach((featureKey) => features.add(featureKey))
    reads.lookups.forEach((lookupKey) => {
      const lookup = index.lookups.get(lookupKey)
      if (lookup) features.add(lookup.keyedBy)
    })
    pending.push(...reads.formulas)
  }
  return features
}

export function checkNumericExpressionReferences(index: DefinitionIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const formula of index.definition.formulas) {
    const reads = expressionReads(formula.expr)
    const refs = [{ kind: 'formula' as const, key: formula.key }]
    for (const featureKey of reads.features) {
      const feature = index.features.get(featureKey)
      if (!feature) {
        issues.push({ check: 'numeric_expr_reference', code: 'unknown_feature', params: { featureKey, ownerKey: formula.key }, refs })
        continue
      }
      const numeric =
        feature.type === 'number' ||
        ((feature.type === 'choice' || feature.type === 'color') && allNumeric(optionDomain(index, feature)))
      if (!numeric) {
        issues.push({
          check: 'numeric_expr_reference',
          code: 'expr_feature_not_numeric',
          params: { featureKey, formulaKey: formula.key },
          refs: [...refs, { kind: 'feature', key: featureKey }],
        })
      }
    }
    for (const formulaKey of reads.formulas) {
      if (index.formulas.has(formulaKey)) continue
      issues.push({ check: 'numeric_expr_reference', code: 'unknown_formula', params: { formulaKey, ownerKey: formula.key }, refs })
    }
    for (const lookupKey of reads.lookups) {
      const lookup = index.lookups.get(lookupKey)
      if (!lookup) {
        issues.push({ check: 'numeric_expr_reference', code: 'unknown_lookup', params: { lookupKey, ownerKey: formula.key }, refs })
        continue
      }
      if (lookup.kind !== 'value' || !allNumeric(lookup.rows.map((row) => row.value))) {
        issues.push({
          check: 'numeric_expr_reference',
          code: 'expr_lookup_not_numeric',
          params: { lookupKey, formulaKey: formula.key },
          refs: [...refs, { kind: 'lookup', key: lookupKey }],
        })
      }
    }
  }
  return issues
}

function allNumeric(values: readonly (string | number)[]): boolean {
  return values.length > 0 && values.every((value) => toFiniteNumber(value) !== null)
}

/** One issue per strongly connected group of formulas that read each other (Tarjan). */
export function checkFormulaCycles(definition: ConfigurationDefinition): ValidationIssue[] {
  const edges = new Map<string, string[]>()
  for (const formula of definition.formulas) {
    if (!edges.has(formula.key)) edges.set(formula.key, [...expressionReads(formula.expr).formulas])
  }

  const issues: ValidationIssue[] = []
  const indexOf = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const visit = (key: string) => {
    indexOf.set(key, indexOf.size)
    lowLink.set(key, indexOf.get(key) ?? 0)
    stack.push(key)
    onStack.add(key)
    for (const next of edges.get(key) ?? []) {
      if (!edges.has(next)) continue
      if (!indexOf.has(next)) {
        visit(next)
        lowLink.set(key, Math.min(lowLink.get(key) ?? 0, lowLink.get(next) ?? 0))
      } else if (onStack.has(next)) {
        lowLink.set(key, Math.min(lowLink.get(key) ?? 0, indexOf.get(next) ?? 0))
      }
    }
    if (lowLink.get(key) !== indexOf.get(key)) return
    const group: string[] = []
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member)
      group.push(member)
      if (member === key) break
    }
    const selfLoop = group.length === 1 && (edges.get(key) ?? []).includes(key)
    if (group.length > 1 || selfLoop) {
      const formulaKeys = group.reverse()
      issues.push({
        check: 'formula_cycle',
        code: 'formula_cycle',
        params: { formulaKeys },
        refs: formulaKeys.map((formulaKey) => ({ kind: 'formula' as const, key: formulaKey })),
      })
    }
  }

  for (const key of edges.keys()) if (!indexOf.has(key)) visit(key)
  return issues
}
