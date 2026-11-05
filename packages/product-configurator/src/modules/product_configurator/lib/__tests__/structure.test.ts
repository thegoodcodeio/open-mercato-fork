import { ConfiguratorEvaluationError } from '../evaluator/errors'
import { MAX_SETTLE_PASSES } from '../evaluator/structure'
import { build, choiceFeature, setRule, structureOf } from './fixtures'

function evaluationError(run: () => unknown): ConfiguratorEvaluationError {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfiguratorEvaluationError) return error
    throw error
  }
  throw new Error('expected a ConfiguratorEvaluationError')
}

function chainDefinition(length: number) {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, length + 1)
  return build((input) => {
    input.features = keys.map((key, index) => choiceFeature(key, index + 1))
    input.formulas = []
    input.lookups = []
    input.bom = []
    input.rules = keys
      .slice(0, length)
      .map((key, index) =>
        setRule(`CHAIN-${index}`, length - index, { featureKey: key, value: 'y' }, { featureKey: keys[index + 1], value: 'y' }),
      )
  })
}

describe('evaluateStructure: normalise', () => {
  it('applies defaults for missing and null selections', () => {
    const result = structureOf(build(), { length: null })
    expect(result.selections).toEqual({
      motor: 'standard',
      length: 2,
      cover: false,
      color: 'red',
      seal: 'epdm',
      remote: false,
    })
  })

  it('coerces numeric strings and boolean tokens', () => {
    const result = structureOf(build(), { length: '3.5', cover: 'true' })
    expect(result.selections.length).toBe(3.5)
    expect(result.selections.cover).toBe(true)
  })

  it('rejects unknown keys, bounds, step, type and option membership with invalid_selection', () => {
    const error = evaluationError(() =>
      structureOf(build(), { ghost: 1, length: 0.5, motor: 'turbo', cover: 'maybe', color: true }),
    )
    expect(error.code).toBe('invalid_selection')
    expect(error.issues).toEqual([
      { featureKey: 'ghost', reason: 'unknown_feature', value: 1 },
      { featureKey: 'motor', reason: 'not_an_option', value: 'turbo' },
      { featureKey: 'length', reason: 'below_min', value: 0.5 },
      { featureKey: 'cover', reason: 'type', value: 'maybe' },
      { featureKey: 'color', reason: 'type', value: true },
    ])
  })

  it('enforces max and step exactly on decimals', () => {
    expect(evaluationError(() => structureOf(build(), { length: 21 })).issues[0].reason).toBe('above_max')
    expect(evaluationError(() => structureOf(build(), { length: 2.3 })).issues[0].reason).toBe('step')
    expect(structureOf(build(), { length: 19.5 }).selections.length).toBe(19.5)
  })

  it('accepts a value from the lookup domain for a lookup-only choice feature', () => {
    const definition = build((input) => {
      const seal = input.features.find((feature) => feature.key === 'seal')
      if (seal) delete seal.options
    })
    expect(structureOf(definition, { seal: 'viton' }).selections.seal).toBe('viton')
    expect(evaluationError(() => structureOf(definition, { seal: 'nitrile' })).issues[0].reason).toBe('not_an_option')
  })
})

describe('evaluateStructure: visibility', () => {
  it('gives a hidden feature its default and restores the user value once visible', () => {
    const hidden = structureOf(build(), { remote: true })
    expect(hidden.visibility.remote).toBe(false)
    expect(hidden.selections.remote).toBe(false)

    const shown = structureOf(build(), { remote: true, motor: 'heavy', seal: 'viton' })
    expect(shown.visibility.remote).toBe(true)
    expect(shown.selections.remote).toBe(true)
  })

  it('lets rules read the default of a hidden feature', () => {
    const definition = build((input) => {
      input.rules = [
        {
          id: 'WARN-REMOTE',
          effect: 'warning',
          when: [{ kind: 'compare', featureKey: 'remote', op: 'eq', value: 'true' }],
          messageTemplate: 'Remote',
          featureKeys: ['remote'],
          order: 1,
        },
      ]
    })
    expect(structureOf(definition, { remote: true }).warnings).toEqual([])
    expect(structureOf(definition, { remote: true, motor: 'heavy', seal: 'viton' }).warnings).toHaveLength(1)
  })

  it('restores the user value when a force makes a hidden feature visible in a later pass', () => {
    const definition = build((input) => {
      input.features.push(choiceFeature('trigger', 7))
      input.rules = [setRule('FORCE-HEAVY', 1, { featureKey: 'trigger', value: 'y' }, { featureKey: 'motor', value: 'heavy' })]
    })
    const result = structureOf(definition, { trigger: 'y', remote: true, seal: 'viton' })
    expect(result.selections.motor).toBe('heavy')
    expect(result.visibility.remote).toBe(true)
    expect(result.selections.remote).toBe(true)
  })

  it('does not let a force write a hidden feature', () => {
    const definition = build((input) => {
      input.rules = [setRule('FORCE-REMOTE', 1, { featureKey: 'color', value: 'red' }, { featureKey: 'remote', value: true })]
    })
    const result = structureOf(definition)
    expect(result.selections.remote).toBe(false)
    expect(result.forced).toEqual([])
  })
})

describe('evaluateStructure: force rules', () => {
  it('applies set, map and lookup_default in order and reports net forced changes', () => {
    const definition = build((input) => {
      input.features.push(choiceFeature('region', 7))
      input.rules = [
        {
          id: 'MAP-COLOR',
          effect: 'force',
          when: [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }],
          action: { kind: 'map', featureKey: 'color', from: { red: 'blue' } },
          messageTemplate: '',
          featureKeys: ['color'],
          order: 2,
        },
        {
          id: 'SEAL-DEFAULT',
          effect: 'force',
          when: [{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }],
          action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' },
          messageTemplate: '',
          featureKeys: ['seal'],
          order: 3,
        },
        setRule('SET-HEAVY', 1, { featureKey: 'region', value: 'y' }, { featureKey: 'motor', value: 'heavy' }),
      ]
    })
    const result = structureOf(definition, { region: 'y' })
    expect(result.selections).toMatchObject({ motor: 'heavy', color: 'blue', seal: 'viton' })
    expect(result.forced).toEqual([
      { featureKey: 'motor', ruleId: 'SET-HEAVY', from: 'standard', to: 'heavy' },
      { featureKey: 'color', ruleId: 'MAP-COLOR', from: 'red', to: 'blue' },
      { featureKey: 'seal', ruleId: 'SEAL-DEFAULT', from: 'epdm', to: 'viton' },
    ])
    expect(result.finalisable).toBe(true)
  })

  it('keeps the user value when the force condition does not hold', () => {
    const definition = build((input) => {
      input.features.push(choiceFeature('region', 7))
      input.rules = [setRule('SET-HEAVY', 1, { featureKey: 'region', value: 'y' }, { featureKey: 'motor', value: 'heavy' })]
    })
    expect(structureOf(definition, { region: 'x', motor: 'standard' }).selections.motor).toBe('standard')
    expect(structureOf(definition, { region: 'y', motor: 'standard', seal: 'viton' }).selections.motor).toBe('heavy')
  })

  it('writes nothing for a map without an entry or a lookup_default without a row', () => {
    const definition = build((input) => {
      input.rules = [
        {
          id: 'MAP-NONE',
          effect: 'force',
          when: [],
          action: { kind: 'map', featureKey: 'color', from: { blue: 'red' } },
          messageTemplate: '',
          featureKeys: ['color'],
          order: 1,
        },
        {
          id: 'DEFAULT-NONE',
          effect: 'force',
          when: [],
          action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'color' },
          messageTemplate: '',
          featureKeys: ['seal'],
          order: 2,
        },
      ]
    })
    const result = structureOf(definition)
    expect(result.forced).toEqual([])
    expect(result.selections.color).toBe('red')
  })

  it('settles a chain that needs the maximum number of passes', () => {
    const result = structureOf(chainDefinition(MAX_SETTLE_PASSES), { a: 'y' })
    expect(result.selections).toEqual({ a: 'y', b: 'y', c: 'y', d: 'y' })
    expect(result.forced.map((change) => change.featureKey)).toEqual(['b', 'c', 'd'])
  })

  it('fails with fixed_point_not_reached when the confirming pass still changes values', () => {
    const error = evaluationError(() => structureOf(chainDefinition(MAX_SETTLE_PASSES + 1), { a: 'y' }))
    expect(error.code).toBe('fixed_point_not_reached')
    expect(error.params).toEqual({ ruleIds: ['CHAIN-3'], featureKeys: ['e'] })
  })

  it('fails with fixed_point_not_reached for rules that keep flipping a value', () => {
    const definition = build((input) => {
      input.features.push(choiceFeature('flip', 7))
      input.rules = [
        {
          id: 'FLIP',
          effect: 'force',
          when: [],
          action: { kind: 'map', featureKey: 'flip', from: { x: 'y', y: 'x' } },
          messageTemplate: '',
          featureKeys: ['flip'],
          order: 1,
        },
      ]
    })
    expect(evaluationError(() => structureOf(definition)).code).toBe('fixed_point_not_reached')
  })

  it('lets a force rule read a calculated condition rebuilt from values forced in an earlier pass', () => {
    const definition = build((input) => {
      input.features.push(choiceFeature('mode', 7), choiceFeature('reinforced', 8))
      input.formulas.push({
        key: 'area',
        expr: {
          kind: 'op',
          op: '*',
          left: { kind: 'feature', featureKey: 'length' },
          right: { kind: 'feature', featureKey: 'length' },
        },
      })
      input.rules = [
        {
          id: 'REINFORCE',
          effect: 'force',
          when: [{ kind: 'calculated', formulaKey: 'area', op: 'gt', value: 10 }],
          action: { kind: 'set', featureKey: 'reinforced', value: 'y' },
          messageTemplate: '',
          featureKeys: ['reinforced'],
          order: 1,
        },
        setRule('BIG', 2, { featureKey: 'mode', value: 'y' }, { featureKey: 'length', value: 4 }),
      ]
    })
    const result = structureOf(definition, { mode: 'y' })
    expect(result.selections).toMatchObject({ length: 4, reinforced: 'y' })
    expect(result.calculated.area).toBe(16)
    expect(result.forced.map((change) => change.ruleId)).toEqual(['BIG', 'REINFORCE'])
  })

  it('fails with forced_value_invalid when a force writes a value outside options or bounds', () => {
    const outsideOptions = build((input) => {
      input.rules = [setRule('BAD-COLOR', 1, { featureKey: 'motor', value: 'standard' }, { featureKey: 'color', value: 'green' })]
    })
    const optionsError = evaluationError(() => structureOf(outsideOptions))
    expect(optionsError.code).toBe('forced_value_invalid')
    expect(optionsError.params).toEqual({ featureKey: 'color', ruleId: 'BAD-COLOR', value: 'green', reason: 'not_an_option' })

    const outsideBounds = build((input) => {
      input.rules = [setRule('BAD-LENGTH', 1, { featureKey: 'motor', value: 'standard' }, { featureKey: 'length', value: 50 })]
    })
    expect(evaluationError(() => structureOf(outsideBounds)).params.reason).toBe('above_max')
  })
})

describe('evaluateStructure: formulas, BOM and rules', () => {
  it('computes formulas rounded to their decimals and BOM quantities from formulas', () => {
    const result = structureOf(build(), { length: 3.5 })
    expect(result.calculated).toEqual({ pipe_meters: 3.75, weight: 80 })
    expect(result.bom).toEqual([
      { bomId: 'base', sku: 'PUMP-BASE', quantity: '1', uom: 'pcs' },
      { bomId: 'motor', sku: 'MOTOR-STD', quantity: '1', uom: 'pcs' },
      { bomId: 'pipe', sku: 'PIPE-M', quantity: '3.75', uom: 'm' },
    ])
  })

  it('rounds a formula without decimals to six decimals for the BOM quantity', () => {
    const definition = build((input) => {
      input.formulas[0] = {
        key: 'pipe_meters',
        expr: { kind: 'op', op: '/', left: { kind: 'const', value: 10 }, right: { kind: 'const', value: 3 } },
      }
    })
    const result = structureOf(definition)
    expect(result.calculated.pipe_meters).toBe(3.333333)
    expect(result.bom[2].quantity).toBe('3.333333')
  })

  it('includes conditional lines and keeps repeated SKUs as separate lines', () => {
    const result = structureOf(build(), { cover: true })
    expect(result.bom.map((line) => line.bomId)).toEqual(['base', 'motor', 'pipe', 'pipe_extra'])
  })

  it('adds the blocking error bom_sku_unmapped when a lookup has no SKU row', () => {
    const definition = build((input) => {
      const skus = input.lookups.find((lookup) => lookup.key === 'motor_skus')
      if (skus?.kind === 'value') skus.rows = skus.rows.filter((row) => row.match !== 'heavy')
    })
    const result = structureOf(definition, { motor: 'heavy', seal: 'viton' })
    expect(result.bom.map((line) => line.bomId)).toEqual(['base', 'pipe'])
    expect(result.errors).toEqual([
      { code: 'bom_sku_unmapped', params: { bomId: 'motor', featureKey: 'motor', value: 'heavy' } },
    ])
    expect(result.finalisable).toBe(false)
  })

  it('adds the blocking error bom_negative_quantity when a quantity formula is negative', () => {
    const definition = build((input) => {
      input.formulas[0] = {
        key: 'pipe_meters',
        expr: { kind: 'op', op: '-', left: { kind: 'feature', featureKey: 'length' }, right: { kind: 'const', value: 5 } },
      }
    })
    const result = structureOf(definition, { length: 3 })
    expect(result.bom.map((line) => line.bomId)).toEqual(['base', 'motor'])
    expect(result.errors).toEqual([
      { code: 'bom_negative_quantity', params: { bomId: 'pipe', formulaKey: 'pipe_meters', quantity: -2 } },
    ])
    expect(result.finalisable).toBe(false)
    expect(structureOf(definition, { length: 5 }).bom.find((line) => line.bomId === 'pipe')?.quantity).toBe('0')
  })

  it('evaluates error and warning rules in order with placeholder params', () => {
    const definition = build((input) => {
      input.rules = [
        {
          id: 'W-LONG',
          effect: 'warning',
          when: [{ kind: 'compare', featureKey: 'length', op: 'gte', value: 10 }],
          messageTemplate: '{feature.motor} with {formula.pipe_meters} m; seals {lookup.seals_by_motor}; weight {lookup.motor_weight}',
          featureKeys: ['length'],
          order: 2,
        },
        {
          id: 'E-HEAVY-LONG',
          effect: 'error',
          when: [
            { kind: 'compare', featureKey: 'length', op: 'gt', value: 15 },
            { kind: 'compare', featureKey: 'motor', op: 'neq', value: 'heavy' },
          ],
          messageTemplate: 'Too long for {feature.motor}',
          featureKeys: ['length', 'motor'],
          order: 1,
        },
        {
          id: 'W-FIRST',
          effect: 'warning',
          when: [],
          messageTemplate: 'Always',
          featureKeys: [],
          order: 1,
        },
      ]
    })
    const result = structureOf(definition, { length: 16 })
    expect(result.errors).toEqual([{ ruleId: 'E-HEAVY-LONG', params: { 'feature.motor': 'standard' } }])
    expect(result.warnings).toEqual([
      { ruleId: 'W-FIRST', params: {} },
      {
        ruleId: 'W-LONG',
        params: {
          'feature.motor': 'standard',
          'formula.pipe_meters': 16.25,
          'lookup.seals_by_motor': ['epdm', 'viton'],
          'lookup.motor_weight': '40',
        },
      },
    ])
    expect(result.finalisable).toBe(false)
  })
})

describe('evaluateStructure: availability', () => {
  it('allows the permitted row values and all options elsewhere', () => {
    const result = structureOf(build())
    expect(result.availability).toEqual({
      motor: { allowedValues: ['standard', 'heavy'] },
      color: { allowedValues: ['red', 'blue'] },
      seal: { allowedValues: ['epdm', 'viton'] },
    })
    expect(result.finalisable).toBe(true)
  })

  it('adds option_not_available for a valid option outside the permitted row', () => {
    const result = structureOf(build(), { seal: 'ptfe' })
    expect(result.errors).toEqual([{ code: 'option_not_available', params: { featureKey: 'seal', value: 'ptfe' } }])
    expect(result.finalisable).toBe(false)
  })

  it('adds no_permitted_values when the lookup has no row for the keyed selection', () => {
    const definition = build((input) => {
      const seals = input.lookups.find((lookup) => lookup.key === 'seals_by_motor')
      if (seals?.kind === 'permitted') seals.rows = seals.rows.filter((row) => row.match !== 'heavy')
    })
    const result = structureOf(definition, { motor: 'heavy', seal: 'viton' })
    expect(result.availability.seal).toEqual({ allowedValues: [], reason: 'no_permitted_values' })
    expect(result.errors).toEqual([
      {
        code: 'no_permitted_values',
        params: { featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor', value: 'heavy' },
      },
    ])
  })

  it('exempts hidden features from availability errors', () => {
    const definition = build((input) => {
      const seal = input.features.find((feature) => feature.key === 'seal')
      if (!seal) return
      seal.visibleWhen = [{ kind: 'compare', featureKey: 'cover', op: 'eq', value: 'true' }]
      seal.default = 'ptfe'
    })
    expect(structureOf(definition).errors).toEqual([])
    expect(structureOf(definition, { cover: true }).errors).toEqual([
      { code: 'option_not_available', params: { featureKey: 'seal', value: 'ptfe' } },
    ])
  })
})

describe('evaluateStructure: surcharge', () => {
  function surchargeDefinition() {
    return build((input) => {
      input.bom.push({
        id: 'cover_line',
        sku: 'COVER',
        uom: 'pcs',
        quantity: 1,
        when: [{ kind: 'compare', featureKey: 'cover', op: 'eq', value: 'true' }],
        ruleId: 'SURCHARGE-COVER',
        order: 5,
      })
      input.rules = [
        {
          id: 'SURCHARGE-COVER',
          effect: 'surcharge',
          when: [{ kind: 'compare', featureKey: 'color', op: 'eq', value: 'blue' }],
          messageTemplate: 'Blue cover adds {line.cover_line.total}',
          featureKeys: ['cover'],
          order: 1,
        },
      ]
    })
  }

  it('includes the bound line by its own condition and never changes selections', () => {
    const result = structureOf(surchargeDefinition(), { cover: true })
    expect(result.bom.map((line) => line.bomId)).toContain('cover_line')
    expect(result.bom.find((line) => line.bomId === 'cover_line')?.ruleId).toBe('SURCHARGE-COVER')
    expect(result.forced).toEqual([])
    expect(result.surcharges).toEqual([])
  })

  it('shows the message only when the rule holds and the line is in the BOM', () => {
    expect(structureOf(surchargeDefinition(), { cover: true, color: 'blue' }).surcharges).toEqual([
      { ruleId: 'SURCHARGE-COVER', bomId: 'cover_line', params: {} },
    ])
    expect(structureOf(surchargeDefinition(), { cover: false, color: 'blue' }).surcharges).toEqual([])
  })
})

describe('evaluateStructure: values named like Object.prototype members', () => {
  it('treats a map table without an entry for "constructor" or "toString" as no write', () => {
    const definition = build((input) => {
      input.features.push({
        ...choiceFeature('trim', 7),
        options: [
          { value: 'constructor', label: 'C', order: 1 },
          { value: 'toString', label: 'T', order: 2 },
          { value: 'plain', label: 'P', order: 3 },
        ],
        default: 'plain',
      })
      input.rules = [
        {
          id: 'MAP-TRIM',
          effect: 'force',
          when: [],
          action: { kind: 'map', featureKey: 'trim', from: { plain: 'toString' } },
          messageTemplate: '',
          featureKeys: ['trim'],
          order: 1,
        },
      ]
    })

    expect(structureOf(definition, { trim: 'constructor' }).selections.trim).toBe('constructor')
    expect(structureOf(definition, { trim: 'toString' }).selections.trim).toBe('toString')
    expect(structureOf(definition, { trim: 'plain' }).selections.trim).toBe('toString')
  })

  it('rejects selections keyed "constructor" or "__proto__" as unknown features', () => {
    const selections = JSON.parse('{"constructor": 1, "toString": 2}')
    const error = evaluationError(() => structureOf(build(), selections))
    expect(error.issues).toEqual([
      { featureKey: 'constructor', reason: 'unknown_feature', value: 1 },
      { featureKey: 'toString', reason: 'unknown_feature', value: 2 },
    ])
  })
})
