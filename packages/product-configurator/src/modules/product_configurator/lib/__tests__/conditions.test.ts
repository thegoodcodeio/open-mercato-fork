import type { Condition } from '../../data/validators'
import { conditionHolds, conditionsHold, tokenize } from '../conditions'
import { createContext, indexDefinition } from '../evaluator/context'
import type { Selections } from '../values'
import { build } from './fixtures'

const definition = build((input) => {
  input.features.push({
    key: 'cameras',
    label: 'Cameras',
    type: 'choice',
    options: [
      { value: 'none', label: 'None', order: 1 },
      { value: 'rear and front', label: 'Rear and front', order: 2 },
    ],
    default: 'none',
    order: 7,
    inSummary: false,
  })
})

const defaults: Selections = {
  motor: 'standard',
  length: 8,
  cover: true,
  color: 'red',
  seal: 'epdm',
  remote: false,
  cameras: 'rear and front',
}

function holds(condition: Condition, selections: Selections = {}): boolean {
  return conditionHolds(condition, createContext(indexDefinition(definition), { ...defaults, ...selections }))
}

describe('conditions', () => {
  it('compares eq and neq as strings', () => {
    expect(holds({ kind: 'compare', featureKey: 'length', op: 'eq', value: '8' })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'cover', op: 'eq', value: true })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'cover', op: 'eq', value: 'true' })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'motor', op: 'neq', value: 'heavy' })).toBe(true)
  })

  it('compares ordering operators as numbers and fails on non-numeric values', () => {
    expect(holds({ kind: 'compare', featureKey: 'length', op: 'gt', value: 7 })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'length', op: 'gte', value: 8 })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'length', op: 'lt', value: 8 })).toBe(false)
    expect(holds({ kind: 'compare', featureKey: 'length', op: 'lte', value: 8 })).toBe(true)
    expect(holds({ kind: 'compare', featureKey: 'motor', op: 'lt', value: 100 })).toBe(false)
    expect(holds({ kind: 'compare', featureKey: 'cover', op: 'gte', value: 0 })).toBe(false)
  })

  it('matches includes and not_includes on whole whitespace tokens', () => {
    expect(tokenize('  rear   and front ')).toEqual(['rear', 'and', 'front'])
    expect(holds({ kind: 'includes', featureKey: 'cameras', value: 'rear' })).toBe(true)
    expect(holds({ kind: 'includes', featureKey: 'cameras', value: 'fro' })).toBe(false)
    expect(holds({ kind: 'not_includes', featureKey: 'cameras', value: 'side' })).toBe(true)
    expect(holds({ kind: 'not_includes', featureKey: 'cameras', value: 'front' })).toBe(false)
  })

  it('checks not_in_lookup against the permitted row, treating a missing row as no allowed values', () => {
    const condition: Condition = { kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }
    expect(holds(condition)).toBe(false)
    expect(holds(condition, { motor: 'heavy' })).toBe(true)
    expect(holds({ ...condition, keyedBy: 'color' })).toBe(true)
  })

  it('compares calculated formula values', () => {
    expect(holds({ kind: 'calculated', formulaKey: 'pipe_meters', op: 'gt', value: 8.2 })).toBe(true)
    expect(holds({ kind: 'calculated', formulaKey: 'pipe_meters', op: 'lt', value: 8.25 })).toBe(false)
  })

  it('treats an empty list as true and combines conditions with AND', () => {
    const context = createContext(indexDefinition(definition), defaults)
    expect(conditionsHold([], context)).toBe(true)
    expect(conditionsHold(undefined, context)).toBe(true)
    expect(
      conditionsHold(
        [
          { kind: 'compare', featureKey: 'motor', op: 'eq', value: 'standard' },
          { kind: 'compare', featureKey: 'length', op: 'gt', value: 100 },
        ],
        context,
      ),
    ).toBe(false)
  })
})
