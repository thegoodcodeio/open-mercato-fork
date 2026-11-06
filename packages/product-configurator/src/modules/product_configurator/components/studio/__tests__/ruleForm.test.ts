import type { Rule } from '../../../data/validators'
import { build } from '../../../lib/__tests__/fixtures'
import {
  RULE_ERROR_KEYS,
  formToRule,
  insertToken,
  nextMapRow,
  ruleToForm,
  surchargeLineIds,
  withActionKind,
  withConditions,
} from '../tabs/ruleForm'

const RULES: Rule[] = [
  {
    id: 'heavy-cover',
    label: 'Heavy motor needs a cover',
    effect: 'error',
    when: [
      { kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' },
      { kind: 'compare', featureKey: 'length', op: 'gte', value: 9.5 },
    ],
    messageTemplate: 'A {feature.length} m pipe with the heavy motor needs a cover.',
    featureKeys: ['motor', 'length', 'cover'],
    order: 10,
  },
  {
    id: 'set_cover',
    effect: 'force',
    when: [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }],
    action: { kind: 'set', featureKey: 'cover', value: true },
    messageTemplate: '',
    featureKeys: ['motor'],
    order: 20,
  },
  {
    id: 'map_colour',
    effect: 'force',
    when: [],
    action: { kind: 'map', featureKey: 'color', from: { red: 'blue' } },
    messageTemplate: '',
    featureKeys: [],
    order: 30,
  },
  {
    id: 'seal_default',
    effect: 'force',
    when: [{ kind: 'calculated', formulaKey: 'weight', op: 'gt', value: 100 }],
    action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' },
    messageTemplate: 'Weight {formula.weight} kg.',
    featureKeys: [],
    order: 40,
  },
  {
    id: 'pipe_surcharge',
    effect: 'surcharge',
    when: [{ kind: 'includes', featureKey: 'motor', value: 'heavy' }],
    messageTemplate: 'Extra pipe adds {line.pipe_extra.total}.',
    featureKeys: ['motor'],
    order: 50,
  },
]

describe('rule row editor form', () => {
  const definition = build((input) => {
    input.rules = RULES
    input.bom[3] = { ...input.bom[3], ruleId: 'pipe_surcharge' }
  })

  it('round-trips every effect and action kind', () => {
    for (const rule of definition.rules) {
      expect(formToRule(ruleToForm(rule, 100, definition), [], definition)).toEqual({ ok: true, rule })
    }
  })

  it('starts a new rule with the next order and highlighted fields that follow the conditions', () => {
    const values = ruleToForm(undefined, 60, definition)
    expect(values).toMatchObject({ effect: 'error', order: '60', featureKeys: [], featureKeysEdited: false })
    const next = withConditions(values, RULES[0].when)
    expect(next.featureKeys).toEqual(['motor', 'length'])
  })

  it('keeps highlighted fields the admin edited when the conditions change', () => {
    const values = ruleToForm(RULES[0], 0, definition)
    expect(values.featureKeysEdited).toBe(true)
    expect(withConditions(values, []).featureKeys).toEqual(['motor', 'length', 'cover'])
    expect(ruleToForm(RULES[1], 0, definition).featureKeysEdited).toBe(false)
  })

  it('reports id, order and action errors instead of building an invalid rule', () => {
    const values = {
      ...ruleToForm(undefined, 10, definition),
      id: 'set_cover',
      order: '1.5',
      effect: 'force' as const,
      action: { kind: 'map' as const, featureKey: 'color', setValue: '', lookupKey: '', mapRows: [{ from: 'red', to: '' }, { from: 'red', to: 'blue' }] },
    }
    expect(formToRule(values, ['set_cover'], definition)).toEqual({
      ok: false,
      errors: {
        id: RULE_ERROR_KEYS.duplicateId,
        order: RULE_ERROR_KEYS.integer,
        'action.mapRows.0.to': RULE_ERROR_KEYS.required,
        'action.mapRows.1.from': RULE_ERROR_KEYS.duplicateMapRow,
      },
    })
    expect(formToRule({ ...values, id: 'has space', order: '1', action: { ...values.action, mapRows: [] } }, [], definition)).toEqual({
      ok: false,
      errors: { id: RULE_ERROR_KEYS.invalidId, 'action.mapRows': RULE_ERROR_KEYS.mapRowsRequired },
    })
  })

  it('reads the order as a decimal integer only', () => {
    const values = { ...ruleToForm(RULES[1], 0, definition) }
    for (const order of ['0x10', '0b10', '0o7', 'Infinity', '', '  ']) {
      expect(formToRule({ ...values, order }, [], definition)).toEqual({ ok: false, errors: { order: RULE_ERROR_KEYS.integer } })
    }
    const padded = formToRule({ ...values, order: ' 7 ' }, [], definition)
    expect(padded.ok && padded.rule.order).toBe(7)
  })

  it('takes keyedBy of a lookup default from the picked lookup on save, like a BOM line', () => {
    const rekeyed = {
      ...definition,
      lookups: definition.lookups.map((lookup) => (lookup.key === 'seals_by_motor' ? { ...lookup, keyedBy: 'length' } : lookup)),
    }
    const values = ruleToForm(RULES[3], 0, rekeyed)
    const result = formToRule(values, [], rekeyed)
    expect(result.ok && result.rule.action).toEqual({ kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'length' })

    const missing = formToRule({ ...values, action: { ...values.action, lookupKey: 'gone' } }, [], rekeyed)
    expect(missing).toEqual({ ok: false, errors: { 'action.lookupKey': RULE_ERROR_KEYS.lookupMissing } })
    const notPicked = formToRule({ ...values, action: { ...values.action, lookupKey: '' } }, [], rekeyed)
    expect(notPicked).toEqual({ ok: false, errors: { 'action.lookupKey': RULE_ERROR_KEYS.required } })
  })

  it('drops the action and an empty label for rules that do not set values', () => {
    const values = { ...ruleToForm(RULES[1], 0, definition), effect: 'warning' as const, label: '  ' }
    const result = formToRule(values, [], definition)
    expect(result.ok && result.rule).toEqual({ ...RULES[1], effect: 'warning', action: undefined })
    expect(result.ok && 'action' in result.rule).toBe(false)
  })

  it('switches a map action to a feature with a fixed list of values', () => {
    const action = ruleToForm(RULES[1], 0, definition).action
    expect(withActionKind(action, 'map', definition)).toMatchObject({ kind: 'map', featureKey: 'motor', mapRows: [] })
    expect(nextMapRow([{ from: 'standard', to: 'heavy' }], ['standard', 'heavy'])).toEqual({ from: 'heavy', to: 'standard' })
  })

  it('inserts placeholders at the caret and offers line totals only to the bound surcharge rule', () => {
    expect(insertToken('Adds  now', '{feature.motor}', 5, 5)).toEqual({ text: 'Adds {feature.motor} now', caret: 20 })
    expect(insertToken('Adds', '{x}', null, null)).toEqual({ text: 'Adds{x}', caret: 7 })
    expect(surchargeLineIds(definition, 'surcharge', 'pipe_surcharge')).toEqual(['pipe_extra'])
    expect(surchargeLineIds(definition, 'warning', 'pipe_surcharge')).toEqual([])
    expect(surchargeLineIds(definition, 'surcharge', 'heavy-cover')).toEqual([])
  })
})
