import type {
  BomLineDefinition,
  Condition,
  ConfigurationDefinition,
  Expression,
  Feature,
  Formula,
  Lookup,
  Rule,
  RuleAction,
} from '../data/validators'
import { extractPlaceholders, type Placeholder } from './messages'

export type RenameReferenceKind = 'feature' | 'formula' | 'lookup' | 'rule' | 'bom'

type Rename = (kind: RenameReferenceKind, value: string) => string

function patch<T extends object>(value: T, updates: Partial<T>): T {
  let next = value
  for (const key in updates) {
    const update = updates[key]
    if (update === undefined || update === value[key]) continue
    if (next === value) next = { ...value }
    next[key] = update
  }
  return next
}

function mapList<T>(list: T[], map: (item: T) => T): T[] {
  const mapped = list.map(map)
  return mapped.every((item, index) => item === list[index]) ? list : mapped
}

function renameCondition(condition: Condition, rename: Rename): Condition {
  switch (condition.kind) {
    case 'compare':
    case 'includes':
    case 'not_includes':
      return patch(condition, { featureKey: rename('feature', condition.featureKey) })
    case 'not_in_lookup':
      return patch(condition, {
        featureKey: rename('feature', condition.featureKey),
        lookupKey: rename('lookup', condition.lookupKey),
        keyedBy: rename('feature', condition.keyedBy),
      })
    case 'calculated':
      return patch(condition, { formulaKey: rename('formula', condition.formulaKey) })
  }
}

function renameConditions(conditions: Condition[], rename: Rename): Condition[] {
  return mapList(conditions, (condition) => renameCondition(condition, rename))
}

function renameExpression(expression: Expression, rename: Rename): Expression {
  switch (expression.kind) {
    case 'const':
      return expression
    case 'feature':
      return patch(expression, { featureKey: rename('feature', expression.featureKey) })
    case 'formula':
      return patch(expression, { formulaKey: rename('formula', expression.formulaKey) })
    case 'lookup':
      return patch(expression, { lookupKey: rename('lookup', expression.lookupKey) })
    case 'op':
      return patch(expression, {
        left: renameExpression(expression.left, rename),
        right: renameExpression(expression.right, rename),
      })
  }
}

function renameAction(action: RuleAction, rename: Rename): RuleAction {
  if (action.kind !== 'lookup_default') return patch(action, { featureKey: rename('feature', action.featureKey) })
  return patch(action, {
    featureKey: rename('feature', action.featureKey),
    lookupKey: rename('lookup', action.lookupKey),
    keyedBy: rename('feature', action.keyedBy),
  })
}

function placeholderToken(placeholder: Placeholder, rename: Rename): string {
  if (placeholder.kind === 'line') return `{line.${rename('bom', placeholder.bomId)}.total}`
  return `{${placeholder.kind}.${rename(placeholder.kind, placeholder.key)}}`
}

function renameTemplate(template: string, rename: Rename): string {
  return extractPlaceholders(template).reduce((text, placeholder) => {
    const token = placeholderToken(placeholder, rename)
    return token === placeholder.token ? text : text.replaceAll(placeholder.token, token)
  }, template)
}

function renameFeature(feature: Feature, rename: Rename): Feature {
  return patch(feature, {
    optionsFromLookup: feature.optionsFromLookup === undefined ? undefined : rename('lookup', feature.optionsFromLookup),
    visibleWhen: feature.visibleWhen === undefined ? undefined : renameConditions(feature.visibleWhen, rename),
  })
}

function renameRule(rule: Rule, rename: Rename): Rule {
  return patch(rule, {
    when: renameConditions(rule.when, rename),
    action: rule.action === undefined ? undefined : renameAction(rule.action, rename),
    messageTemplate: renameTemplate(rule.messageTemplate, rename),
    featureKeys: mapList(rule.featureKeys, (featureKey) => rename('feature', featureKey)),
  })
}

function renameFormula(formula: Formula, rename: Rename): Formula {
  return patch(formula, { expr: renameExpression(formula.expr, rename) })
}

function renameLookup(lookup: Lookup, rename: Rename): Lookup {
  return patch(lookup, { keyedBy: rename('feature', lookup.keyedBy) })
}

function renameBomLine(line: BomLineDefinition, rename: Rename): BomLineDefinition {
  const { quantity, skuFromLookup } = line
  return patch(line, {
    skuFromLookup:
      skuFromLookup === undefined
        ? undefined
        : patch(skuFromLookup, {
            lookupKey: rename('lookup', skuFromLookup.lookupKey),
            keyedBy: rename('feature', skuFromLookup.keyedBy),
          }),
    quantity: typeof quantity === 'number' ? quantity : patch(quantity, { formulaKey: rename('formula', quantity.formulaKey) }),
    when: renameConditions(line.when, rename),
    ruleId: line.ruleId === undefined ? undefined : rename('rule', line.ruleId),
  })
}

/**
 * Rewrites every reference to `from` (a feature/formula/lookup key or a rule/BOM id) so it points at `to`.
 * Declarations (a row's own key or id) are left alone: callers rename the edited row themselves.
 * Pure; unchanged branches keep their identity and `definition` is returned when nothing changes.
 */
export function renameReference(
  definition: ConfigurationDefinition,
  kind: RenameReferenceKind,
  from: string,
  to: string,
): ConfigurationDefinition {
  if (from === to) return definition
  const rename: Rename = (candidate, value) => (candidate === kind && value === from ? to : value)
  return patch(definition, {
    features: mapList(definition.features, (feature) => renameFeature(feature, rename)),
    rules: mapList(definition.rules, (rule) => renameRule(rule, rename)),
    formulas: mapList(definition.formulas, (formula) => renameFormula(formula, rename)),
    lookups: mapList(definition.lookups, (lookup) => renameLookup(lookup, rename)),
    bom: mapList(definition.bom, (line) => renameBomLine(line, rename)),
  })
}
