import type {
  ConfigurationDefinition,
  Feature,
  Formula,
  Lookup,
  PermittedLookup,
  ValueLookup,
} from '../../data/validators'
import { FORMULA_MAX_DECIMALS } from '../../data/validators'
import { evaluateExpression } from '../expression'
import { roundNumber } from '../money'
import { selectionKey, type Selections } from '../values'
import { ConfiguratorEvaluationError } from './errors'

export type ValueLookupRow = ValueLookup['rows'][number]
export type PermittedLookupRow = PermittedLookup['rows'][number]

export type DefinitionIndex = {
  definition: ConfigurationDefinition
  features: Map<string, Feature>
  formulas: Map<string, Formula>
  lookups: Map<string, Lookup>
}

export type EvaluationContext = {
  index: DefinitionIndex
  selections: Selections
  valueRow(lookupKey: string, keyedBy: string): ValueLookupRow | null
  permittedRow(lookupKey: string, keyedBy: string): PermittedLookupRow | null
  formula(formulaKey: string): number
}

export function indexDefinition(definition: ConfigurationDefinition): DefinitionIndex {
  return {
    definition,
    features: new Map(definition.features.map((feature) => [feature.key, feature])),
    formulas: new Map(definition.formulas.map((formula) => [formula.key, formula])),
    lookups: new Map(definition.lookups.map((lookup) => [lookup.key, lookup])),
  }
}

export function createContext(index: DefinitionIndex, selections: Selections): EvaluationContext {
  const formulaValues = new Map<string, number>()
  const resolving = new Set<string>()

  const context: EvaluationContext = {
    index,
    selections,
    valueRow(lookupKey, keyedBy) {
      const lookup = index.lookups.get(lookupKey)
      if (lookup?.kind !== 'value') return null
      const match = selectionKey(selections[keyedBy])
      return lookup.rows.find((row) => row.match === match) ?? null
    },
    permittedRow(lookupKey, keyedBy) {
      const lookup = index.lookups.get(lookupKey)
      if (lookup?.kind !== 'permitted') return null
      const match = selectionKey(selections[keyedBy])
      return lookup.rows.find((row) => row.match === match) ?? null
    },
    formula(formulaKey) {
      const cached = formulaValues.get(formulaKey)
      if (cached !== undefined) return cached
      const formula = index.formulas.get(formulaKey)
      if (!formula) {
        throw new ConfiguratorEvaluationError('expression_error', { reason: 'unknown_reference', formulaKey })
      }
      if (resolving.has(formulaKey)) {
        throw new ConfiguratorEvaluationError('expression_error', { reason: 'formula_cycle', formulaKey })
      }
      resolving.add(formulaKey)
      try {
        const raw = evaluateExpression(formula.expr, context, formulaKey)
        const value = roundNumber(raw, formula.decimals ?? FORMULA_MAX_DECIMALS)
        formulaValues.set(formulaKey, value)
        return value
      } finally {
        resolving.delete(formulaKey)
      }
    },
  }

  return context
}
