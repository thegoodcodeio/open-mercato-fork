import {
  definitionSchema,
  type ConfigurationDefinition,
  type ConfigurationDefinitionInput,
} from '../../data/validators'
import { evaluateStructure } from '../evaluator/structure'
import type { RawSelections } from '../../data/validators'

export const PRICE_KIND_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
export const VERSION_ID = '0b6a3c1d-2e4f-4a5b-8c6d-7e8f9a0b1c2d'
export const VERSION_HASH = 'a'.repeat(64)

export function referenceInput(): ConfigurationDefinitionInput {
  return {
    schemaVersion: 1,
    commercial: { currencyCode: 'EUR', priceKindId: PRICE_KIND_ID },
    fixedSpecification: [{ label: 'Housing', value: 'Cast iron' }],
    features: [
      {
        key: 'motor',
        label: 'Motor',
        type: 'choice',
        options: [
          { value: 'standard', label: 'Standard 3 kW', order: 1 },
          { value: 'heavy', label: 'Heavy duty 7 kW', order: 2 },
        ],
        default: 'standard',
        order: 1,
        inSummary: true,
      },
      {
        key: 'length',
        label: 'Pipe length',
        type: 'number',
        min: 1,
        max: 20,
        step: 0.5,
        unit: 'm',
        default: 2,
        order: 2,
        inSummary: true,
      },
      { key: 'cover', label: 'Weather cover', type: 'boolean', default: false, order: 3, inSummary: true },
      {
        key: 'color',
        label: 'Colour',
        type: 'color',
        options: [
          { value: 'red', label: 'Signal red', order: 1, swatch: '#CC0000' },
          { value: 'blue', label: 'Gentian blue', order: 2, swatch: '#0E294B' },
        ],
        default: 'red',
        order: 4,
        inSummary: false,
      },
      {
        key: 'seal',
        label: 'Seal',
        type: 'choice',
        options: [
          { value: 'epdm', label: 'EPDM', order: 1 },
          { value: 'viton', label: 'Viton', order: 2 },
          { value: 'ptfe', label: 'PTFE', order: 3 },
        ],
        optionsFromLookup: 'seals_by_motor',
        default: 'epdm',
        order: 5,
        inSummary: true,
      },
      {
        key: 'remote',
        label: 'Remote control',
        type: 'boolean',
        default: false,
        order: 6,
        inSummary: true,
        visibleWhen: [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }],
      },
    ],
    rules: [],
    formulas: [
      {
        key: 'pipe_meters',
        expr: {
          kind: 'op',
          op: '+',
          left: { kind: 'feature', featureKey: 'length' },
          right: { kind: 'const', value: 0.25 },
        },
        unit: 'm',
        decimals: 2,
      },
      {
        key: 'weight',
        expr: {
          kind: 'op',
          op: '*',
          left: { kind: 'lookup', lookupKey: 'motor_weight' },
          right: { kind: 'const', value: 2 },
        },
        decimals: 1,
      },
    ],
    lookups: [
      {
        kind: 'permitted',
        key: 'seals_by_motor',
        keyedBy: 'motor',
        rows: [
          { match: 'standard', values: ['epdm', 'viton'], default: 'epdm' },
          { match: 'heavy', values: ['viton', 'ptfe'], default: 'viton' },
        ],
      },
      {
        kind: 'value',
        key: 'motor_weight',
        keyedBy: 'motor',
        rows: [
          { match: 'standard', value: '40' },
          { match: 'heavy', value: 65.5 },
        ],
      },
      {
        kind: 'value',
        key: 'motor_skus',
        keyedBy: 'motor',
        rows: [
          { match: 'standard', value: 'MOTOR-STD' },
          { match: 'heavy', value: 'MOTOR-HD' },
        ],
      },
    ],
    bom: [
      { id: 'base', sku: 'PUMP-BASE', uom: 'pcs', quantity: 1, when: [], order: 1 },
      {
        id: 'motor',
        skuFromLookup: { lookupKey: 'motor_skus', keyedBy: 'motor' },
        uom: 'pcs',
        quantity: 1,
        when: [],
        order: 2,
      },
      { id: 'pipe', sku: 'PIPE-M', uom: 'm', quantity: { formulaKey: 'pipe_meters' }, when: [], order: 3 },
      {
        id: 'pipe_extra',
        sku: 'PIPE-M',
        uom: 'm',
        quantity: 1,
        when: [{ kind: 'compare', featureKey: 'cover', op: 'eq', value: 'true' }],
        order: 4,
      },
    ],
  }
}

export const REFERENCE_PRICES: Record<string, string> = {
  'PUMP-BASE': '1000.0000',
  'MOTOR-STD': '250.5050',
  'MOTOR-HD': '480.0000',
  'PIPE-M': '12.3456',
  COVER: '99.9950',
}

export function parseDefinition(input: ConfigurationDefinitionInput): ConfigurationDefinition {
  return definitionSchema.parse(input)
}

export function build(mutate?: (input: ConfigurationDefinitionInput) => void): ConfigurationDefinition {
  const input = referenceInput()
  mutate?.(input)
  return parseDefinition(input)
}

export function structureOf(definition: ConfigurationDefinition, selections: RawSelections = {}) {
  return evaluateStructure({ definition, modelVersionId: VERSION_ID, modelVersionHash: VERSION_HASH, selections })
}

export function choiceFeature(key: string, order: number): ConfigurationDefinitionInput['features'][number] {
  return {
    key,
    label: key.toUpperCase(),
    type: 'choice',
    options: [
      { value: 'x', label: 'X', order: 1 },
      { value: 'y', label: 'Y', order: 2 },
    ],
    default: 'x',
    order,
    inSummary: false,
  }
}

export function setRule(
  id: string,
  order: number,
  when: { featureKey: string; value: string },
  set: { featureKey: string; value: string | number | boolean },
): ConfigurationDefinitionInput['rules'][number] {
  return {
    id,
    effect: 'force',
    when: [{ kind: 'compare', featureKey: when.featureKey, op: 'eq', value: when.value }],
    action: { kind: 'set', featureKey: set.featureKey, value: set.value },
    messageTemplate: '',
    featureKeys: [set.featureKey],
    order,
  }
}
