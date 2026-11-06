import { parseBooleanFromUnknown } from '@open-mercato/shared/lib/boolean'
import type {
  ConfigurationDefinition,
  Feature,
  RawSelections,
  Rule,
  RuleAction,
  SelectionValue,
} from '../../data/validators'
import { conditionsHold } from '../conditions'
import { extractPlaceholders, placeholderParamKey } from '../messages'
import { canonicalDecimal, parseDecimal, QUANTITY_SCALE, toScaled } from '../money'
import { selectionKey, sortByOrder, toFiniteNumber, type Selections } from '../values'
import { createContext, indexDefinition, type DefinitionIndex, type EvaluationContext } from './context'
import { ConfiguratorEvaluationError, type SelectionIssue, type SelectionIssueReason } from './errors'
import type {
  FeatureAvailability,
  ForcedChange,
  IssueParams,
  RuleIssue,
  StructureBomLine,
  StructureError,
  StructureResult,
  SurchargeNotice,
  SystemIssue,
} from './types'

export const MAX_SETTLE_PASSES = 3

export type StructureInput = {
  definition: ConfigurationDefinition
  modelVersionId: string
  modelVersionHash: string
  selections: RawSelections | null | undefined
}

export function evaluateStructure(input: StructureInput): StructureResult {
  const { definition } = input
  const index = indexDefinition(definition)
  const features = sortByOrder(definition.features)

  const intent = normaliseSelections(index, input.selections)
  const settled = settle(index, features, intent)
  validateForcedValues(index, settled.forced)

  const context = createContext(index, settled.selections)
  const calculated: Record<string, number> = {}
  for (const formula of definition.formulas) calculated[formula.key] = context.formula(formula.key)

  const errors: StructureError[] = []
  const bom = buildBom(definition, context, errors)
  const warnings: RuleIssue[] = []
  for (const rule of sortByOrder(definition.rules)) {
    if (rule.effect !== 'error' && rule.effect !== 'warning') continue
    if (!conditionsHold(rule.when, context)) continue
    const issue = { ruleId: rule.id, params: ruleParams(rule, context) }
    if (rule.effect === 'error') errors.push(issue)
    else warnings.push(issue)
  }

  const availability = buildAvailability(features, context)
  errors.push(...availabilityErrors(features, context, settled.visibility, availability))

  return {
    modelVersionId: input.modelVersionId,
    modelVersionHash: input.modelVersionHash,
    currencyCode: definition.commercial.currencyCode,
    priceKindId: definition.commercial.priceKindId,
    selections: settled.selections,
    visibility: settled.visibility,
    forced: settled.forced,
    calculated,
    bom,
    availability,
    errors,
    warnings,
    surcharges: buildSurcharges(definition, context, bom),
    finalisable: errors.length === 0,
  }
}

export function normaliseSelections(index: DefinitionIndex, raw: RawSelections | null | undefined): Selections {
  const input = raw ?? {}
  const issues: SelectionIssue[] = []
  for (const featureKey of Object.keys(input)) {
    if (!index.features.has(featureKey)) {
      issues.push({ featureKey, reason: 'unknown_feature', value: input[featureKey] ?? null })
    }
  }

  const selections: Selections = {}
  for (const feature of index.definition.features) {
    const provided = input[feature.key]
    if (provided === undefined || provided === null) {
      selections[feature.key] = feature.default
      continue
    }
    const coerced = coerceValue(feature, provided)
    const reason = coerced === null ? 'type' : valueIssue(index, feature, coerced)
    if (coerced === null || reason) {
      issues.push({ featureKey: feature.key, reason: reason ?? 'type', value: provided })
      continue
    }
    selections[feature.key] = coerced
  }

  if (issues.length > 0) throw new ConfiguratorEvaluationError('invalid_selection', {}, issues)
  return selections
}

function coerceValue(feature: Feature, value: SelectionValue): SelectionValue | null {
  switch (feature.type) {
    case 'boolean':
      return parseBooleanFromUnknown(value)
    case 'number':
      return toFiniteNumber(value)
    case 'choice':
    case 'color':
      if (typeof value === 'string') return value
      return typeof value === 'number' ? String(value) : null
  }
}

export function valueIssue(index: DefinitionIndex, feature: Feature, value: SelectionValue): SelectionIssueReason | null {
  if (feature.type === 'boolean') return typeof value === 'boolean' ? null : 'type'
  if (feature.type === 'number') return typeof value === 'number' ? numberValueIssue(feature, value) : 'type'
  if (typeof value !== 'string') return 'type'
  return optionDomain(index, feature).includes(value) ? null : 'not_an_option'
}

export function numberValueIssue(feature: Pick<Feature, 'min' | 'max' | 'step'>, value: number): SelectionIssueReason | null {
  if (feature.min !== undefined && value < feature.min) return 'below_min'
  if (feature.max !== undefined && value > feature.max) return 'above_max'
  if (feature.step !== undefined && !isOnStep(value, feature.min ?? 0, feature.step)) return 'step'
  return null
}

/** The reason `settle` would refuse a value a force rule writes, after the same coercion it applies. */
export function forcedValueIssue(index: DefinitionIndex, feature: Feature, value: SelectionValue): SelectionIssueReason | null {
  return valueIssue(index, feature, coerceValue(feature, value) ?? value)
}

function isOnStep(value: number, base: number, step: number): boolean {
  const parts = [parseDecimal(value), parseDecimal(base), parseDecimal(step)]
  const scale = Math.max(...parts.map((part) => part.scale))
  const [scaledValue, scaledBase, scaledStep] = parts.map(
    (part) => part.coefficient * 10n ** BigInt(scale - part.scale),
  )
  return (scaledValue - scaledBase) % scaledStep === 0n
}

export function optionDomain(index: DefinitionIndex, feature: Feature): string[] {
  if (feature.options) return feature.options.map((option) => option.value)
  const lookup = feature.optionsFromLookup ? index.lookups.get(feature.optionsFromLookup) : undefined
  if (lookup?.kind !== 'permitted') return []
  return [...new Set(lookup.rows.flatMap((row) => row.values))]
}

export type SettleResult = { selections: Selections; visibility: Record<string, boolean>; forced: ForcedChange[] }

export function settle(index: DefinitionIndex, features: Feature[], intent: Selections): SettleResult {
  const forceRules = sortByOrder(index.definition.rules).filter((rule) => rule.effect === 'force')
  const state: Selections = { ...intent }
  const firstValues = new Map<string, SelectionValue>()
  const lastRules = new Map<string, string>()
  let hidden = new Set<string>()
  let visibility: Record<string, boolean> = {}

  for (let pass = 0; pass <= MAX_SETTLE_PASSES; pass += 1) {
    const before = { ...state }
    visibility = computeVisibility(features, createContext(index, state))
    const nextHidden = new Set<string>()
    for (const feature of features) {
      if (!visibility[feature.key]) {
        nextHidden.add(feature.key)
        state[feature.key] = feature.default
      } else if (hidden.has(feature.key)) {
        state[feature.key] = intent[feature.key]
      }
    }
    hidden = nextHidden

    const changedRuleIds: string[] = []
    let context = createContext(index, state)
    for (const rule of forceRules) {
      if (!rule.action) continue
      const target = index.features.get(rule.action.featureKey)
      if (!target || hidden.has(target.key)) continue
      if (!conditionsHold(rule.when, context)) continue
      const resolved = resolveAction(rule.action, context)
      if (resolved === null) continue
      const next = coerceValue(target, resolved) ?? resolved
      if (state[target.key] === next) continue
      if (!firstValues.has(target.key)) firstValues.set(target.key, state[target.key])
      state[target.key] = next
      lastRules.set(target.key, rule.id)
      changedRuleIds.push(rule.id)
      context = createContext(index, state)
    }

    const changedFeatureKeys = features
      .filter((feature) => before[feature.key] !== state[feature.key])
      .map((feature) => feature.key)
    if (changedFeatureKeys.length === 0) {
      return { selections: state, visibility, forced: netForcedChanges(firstValues, lastRules, state, hidden) }
    }
    if (pass === MAX_SETTLE_PASSES) {
      throw new ConfiguratorEvaluationError('fixed_point_not_reached', {
        ruleIds: [...new Set(changedRuleIds)],
        featureKeys: changedFeatureKeys,
      })
    }
  }
  throw new Error('[internal] product_configurator: settle loop exited without a result')
}

function computeVisibility(features: Feature[], context: EvaluationContext): Record<string, boolean> {
  const visibility: Record<string, boolean> = {}
  for (const feature of features) visibility[feature.key] = conditionsHold(feature.visibleWhen, context)
  return visibility
}

function resolveAction(action: RuleAction, context: EvaluationContext): SelectionValue | null {
  switch (action.kind) {
    case 'set':
      return action.value
    case 'map': {
      const current = selectionKey(context.selections[action.featureKey])
      return Object.hasOwn(action.from, current) ? action.from[current] : null
    }
    case 'lookup_default':
      return context.permittedRow(action.lookupKey, action.keyedBy)?.default ?? null
  }
}

function netForcedChanges(
  firstValues: Map<string, SelectionValue>,
  lastRules: Map<string, string>,
  state: Selections,
  hidden: Set<string>,
): ForcedChange[] {
  const forced: ForcedChange[] = []
  for (const [featureKey, from] of firstValues) {
    const to = state[featureKey]
    const ruleId = lastRules.get(featureKey)
    if (hidden.has(featureKey) || from === to || ruleId === undefined) continue
    forced.push({ featureKey, ruleId, from, to })
  }
  return forced
}

function validateForcedValues(index: DefinitionIndex, forced: ForcedChange[]): void {
  for (const change of forced) {
    const feature = index.features.get(change.featureKey)
    if (!feature) continue
    const reason = valueIssue(index, feature, change.to)
    if (reason) {
      throw new ConfiguratorEvaluationError('forced_value_invalid', {
        featureKey: change.featureKey,
        ruleId: change.ruleId,
        value: change.to,
        reason,
      })
    }
  }
}

function buildBom(
  definition: ConfigurationDefinition,
  context: EvaluationContext,
  errors: StructureError[],
): StructureBomLine[] {
  const lines: StructureBomLine[] = []
  for (const line of sortByOrder(definition.bom)) {
    if (!conditionsHold(line.when, context)) continue
    const sku = resolveSku(line, context)
    if (sku === null) {
      const featureKey = line.skuFromLookup?.keyedBy ?? ''
      errors.push({
        code: 'bom_sku_unmapped',
        params: { bomId: line.id, featureKey, value: selectionKey(context.selections[featureKey]) },
      })
      continue
    }
    const quantity = typeof line.quantity === 'number' ? line.quantity : context.formula(line.quantity.formulaKey)
    if (quantity < 0) {
      errors.push({
        code: 'bom_negative_quantity',
        params: {
          bomId: line.id,
          formulaKey: typeof line.quantity === 'number' ? null : line.quantity.formulaKey,
          quantity,
        },
      })
      continue
    }
    lines.push({
      bomId: line.id,
      sku,
      quantity: canonicalDecimal(toScaled(quantity, QUANTITY_SCALE), QUANTITY_SCALE),
      uom: line.uom,
      ...(line.ruleId ? { ruleId: line.ruleId } : {}),
    })
  }
  return lines
}

function resolveSku(line: ConfigurationDefinition['bom'][number], context: EvaluationContext): string | null {
  if (line.sku !== undefined) return line.sku
  if (!line.skuFromLookup) return null
  const row = context.valueRow(line.skuFromLookup.lookupKey, line.skuFromLookup.keyedBy)
  return row ? String(row.value) : null
}

function ruleParams(rule: Rule, context: EvaluationContext): IssueParams {
  const params: IssueParams = {}
  for (const placeholder of extractPlaceholders(rule.messageTemplate)) {
    if (placeholder.kind === 'line') continue
    const key = placeholderParamKey(placeholder)
    if (placeholder.kind === 'feature') {
      params[key] = context.selections[placeholder.key] ?? null
    } else if (placeholder.kind === 'formula') {
      params[key] = context.index.formulas.has(placeholder.key) ? context.formula(placeholder.key) : null
    } else {
      params[key] = lookupParam(placeholder.key, context)
    }
  }
  return params
}

function lookupParam(lookupKey: string, context: EvaluationContext): string | number | string[] | null {
  const lookup = context.index.lookups.get(lookupKey)
  if (!lookup) return null
  if (lookup.kind === 'value') return context.valueRow(lookupKey, lookup.keyedBy)?.value ?? null
  return context.permittedRow(lookupKey, lookup.keyedBy)?.values ?? null
}

function buildSurcharges(
  definition: ConfigurationDefinition,
  context: EvaluationContext,
  bom: StructureBomLine[],
): SurchargeNotice[] {
  const notices: SurchargeNotice[] = []
  for (const rule of sortByOrder(definition.rules)) {
    if (rule.effect !== 'surcharge') continue
    const line = bom.find((entry) => entry.ruleId === rule.id)
    if (!line || !conditionsHold(rule.when, context)) continue
    notices.push({ ruleId: rule.id, bomId: line.bomId, params: ruleParams(rule, context) })
  }
  return notices
}

function buildAvailability(features: Feature[], context: EvaluationContext): Record<string, FeatureAvailability> {
  const availability: Record<string, FeatureAvailability> = {}
  for (const feature of features) {
    if (feature.type !== 'choice' && feature.type !== 'color') continue
    const lookup = feature.optionsFromLookup ? context.index.lookups.get(feature.optionsFromLookup) : undefined
    if (lookup?.kind === 'permitted') {
      const row = context.permittedRow(lookup.key, lookup.keyedBy)
      availability[feature.key] = row
        ? { allowedValues: [...row.values] }
        : { allowedValues: [], reason: 'no_permitted_values' }
      continue
    }
    availability[feature.key] = { allowedValues: optionDomain(context.index, feature) }
  }
  return availability
}

function availabilityErrors(
  features: Feature[],
  context: EvaluationContext,
  visibility: Record<string, boolean>,
  availability: Record<string, FeatureAvailability>,
): SystemIssue[] {
  const errors: SystemIssue[] = []
  for (const feature of features) {
    const entry = availability[feature.key]
    if (!entry || !visibility[feature.key]) continue
    const value = selectionKey(context.selections[feature.key])
    if (entry.allowedValues.length === 0) {
      const lookup = feature.optionsFromLookup ? context.index.lookups.get(feature.optionsFromLookup) : undefined
      errors.push({
        code: 'no_permitted_values',
        params: {
          featureKey: feature.key,
          lookupKey: feature.optionsFromLookup ?? null,
          keyedBy: lookup?.keyedBy ?? null,
          value: lookup ? selectionKey(context.selections[lookup.keyedBy]) : null,
        },
      })
    } else if (!entry.allowedValues.includes(value)) {
      errors.push({ code: 'option_not_available', params: { featureKey: feature.key, value } })
    }
  }
  return errors
}
