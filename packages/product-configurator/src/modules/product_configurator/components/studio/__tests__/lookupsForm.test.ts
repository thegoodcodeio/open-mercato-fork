import { TextEncoder } from 'node:util'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { build } from '../../../lib/__tests__/fixtures'
import type { Lookup } from '../../../data/validators'
import {
  firstErrorRow,
  formToLookup,
  keyDomain,
  limitedFeatures,
  lookupToForm,
  missingMatches,
  permittedValueDomain,
  rowValue,
  skuLineIds,
  togglePermittedValue,
  LOOKUP_ERROR_KEYS,
  type LookupFormValues,
} from '../tabs/lookups/lookupForm'

Object.assign(globalThis, { TextEncoder })

const t: TranslateFn = (key, fallback) => (typeof fallback === 'string' ? fallback : key)

function lookupOf(key: string): Lookup {
  const lookup = build().lookups.find((entry) => entry.key === key)
  if (!lookup) throw new Error(`[internal] missing fixture lookup ${key}`)
  return lookup
}

function save(values: LookupFormValues, otherKeys: string[] = [], skuValues = false) {
  const definition = build()
  return formToLookup(values, { definition, domain: keyDomain(definition, values.keyedBy, t), otherKeys, skuValues })
}

describe('lookup form model', () => {
  it('keeps the stored row order and adds a blank row for each option without one', () => {
    const definition = build((input) => {
      const lookup = input.lookups.find((entry) => entry.key === 'motor_skus')
      if (lookup?.kind === 'value') lookup.rows = [{ match: 'legacy', value: 'OLD-1' }, { match: 'heavy', value: 'MOTOR-HD' }]
    })
    const form = lookupToForm(definition.lookups.find((entry) => entry.key === 'motor_skus'), definition, t)
    expect(form.valueRows.map((row) => [row.match, row.text])).toEqual([
      ['legacy', 'OLD-1'],
      ['heavy', 'MOTOR-HD'],
      ['standard', ''],
    ])
    expect(missingMatches(keyDomain(definition, 'motor', t), ['heavy', 'legacy']).map((option) => option.value)).toEqual(['standard'])
  })

  it('types the rows of a number key feature freely and offers boolean options as yes/no', () => {
    const definition = build()
    expect(keyDomain(definition, 'length', t)).toBeNull()
    expect(keyDomain(definition, 'cover', t)?.map((option) => option.value)).toEqual(['true', 'false'])
    expect(missingMatches(null, [])).toEqual([])
  })

  it('drops blank option rows, keeps untouched values and stores numeric text as numbers except SKUs', () => {
    const form = lookupToForm(lookupOf('motor_weight'), build(), t)
    expect(save(form)).toEqual({ ok: true, lookup: lookupOf('motor_weight') })

    const edited: LookupFormValues = {
      ...form,
      valueRows: [
        { match: 'standard', text: '41.5', original: '40' },
        { match: 'heavy', text: '' },
      ],
    }
    expect(save(edited)).toEqual({
      ok: true,
      lookup: { kind: 'value', key: 'motor_weight', keyedBy: 'motor', rows: [{ match: 'standard', value: 41.5 }] },
    })
    expect(rowValue({ match: 'standard', text: ' 100 ' }, true)).toBe('100')
    expect(rowValue({ match: 'standard', text: 'abc' }, false)).toBe('abc')
  })

  it('stores canonical numbers as numbers and any other text as typed', () => {
    expect(rowValue({ match: 'a', text: '40' }, false)).toBe(40)
    expect(rowValue({ match: 'a', text: '1.5' }, false)).toBe(1.5)
    expect(rowValue({ match: 'a', text: '-2' }, false)).toBe(-2)
    expect(rowValue({ match: 'a', text: '007' }, false)).toBe('007')
    expect(rowValue({ match: 'a', text: '1.50' }, false)).toBe('1.50')
    expect(rowValue({ match: 'a', text: '0x10' }, false)).toBe('0x10')
    expect(rowValue({ match: 'a', text: '1e3' }, false)).toBe('1e3')
    expect(rowValue({ match: 'a', text: ' 12 ' }, false)).toBe(12)

    const form = lookupToForm(lookupOf('motor_weight'), build(), t)
    const result = save({
      ...form,
      valueRows: [
        { match: 'standard', text: '007', original: '40' },
        { match: 'heavy', text: '1.50', original: 65.5 },
      ],
    })
    expect(result.ok && result.lookup.rows).toEqual([
      { match: 'standard', value: '007' },
      { match: 'heavy', value: '1.50' },
    ])
  })

  it('saves an unchanged lookup as it was: order, number-like text and blank stored values', () => {
    const definition = build((input) => {
      const lookup = input.lookups.find((entry) => entry.key === 'motor_weight')
      if (lookup?.kind === 'value') {
        lookup.rows = [
          { match: 'heavy', value: '1.50' },
          { match: 'legacy', value: '' },
          { match: 'standard', value: '007' },
        ]
      }
      input.lookups.push({ kind: 'value', key: 'by_length', keyedBy: 'length', rows: [{ match: '9', value: '' }, { match: '2', value: 3 }] })
    })
    for (const key of ['motor_weight', 'by_length', 'seals_by_motor', 'motor_skus']) {
      const lookup = definition.lookups.find((entry) => entry.key === key)
      const form = lookupToForm(lookup, definition, t)
      const result = formToLookup(form, {
        definition,
        domain: keyDomain(definition, form.keyedBy, t),
        otherKeys: [],
        skuValues: skuLineIds(definition, key).length > 0,
      })
      expect(result).toEqual({ ok: true, lookup })
    }
  })

  it('refuses a blank row that is not an option instead of dropping it', () => {
    const definition = build()
    const form = lookupToForm(undefined, definition, t)
    const values: LookupFormValues = {
      ...form,
      key: 'by_length',
      keyedBy: 'length',
      valueRows: [
        { match: '1', text: '10' },
        { match: '2', text: '' },
      ],
    }
    expect(formToLookup(values, { definition, domain: keyDomain(definition, 'length', t), otherKeys: [], skuValues: false })).toEqual({
      ok: false,
      errors: { 'rows.1.value': LOOKUP_ERROR_KEYS.required },
    })
    const permitted = lookupToForm(lookupOf('seals_by_motor'), build(), t)
    expect(save({ ...permitted, permittedRows: [...permitted.permittedRows, { match: 'extra', values: [], default: '' }] })).toEqual({
      ok: false,
      errors: { 'rows.2.values': LOOKUP_ERROR_KEYS.valuesRequired },
    })
  })

  it('reports key, keyed-by and row errors with the form row index', () => {
    const form = lookupToForm(lookupOf('motor_skus'), build(), t)
    const result = save(
      {
        ...form,
        key: 'motor_weight',
        valueRows: [...form.valueRows, { match: 'heavy', text: 'DUP' }, { match: 'extra', text: '' }],
      },
      ['motor_weight'],
    )
    expect(result).toEqual({
      ok: false,
      errors: {
        key: LOOKUP_ERROR_KEYS.duplicateKey,
        'rows.2.match': LOOKUP_ERROR_KEYS.duplicateMatch,
        'rows.3.value': LOOKUP_ERROR_KEYS.required,
      },
    })
    expect(firstErrorRow(result.ok ? {} : result.errors)).toBe(2)
    expect(save({ ...form, key: '9bad', keyedBy: 'missing' })).toEqual({ ok: false, errors: { keyedBy: LOOKUP_ERROR_KEYS.unknownFeature } })
    expect(save({ ...form, key: '9bad' })).toEqual({ ok: false, errors: { key: LOOKUP_ERROR_KEYS.invalidKey } })
  })

  it('keeps permitted values in option order with the default among them', () => {
    const definition = build()
    const domain = permittedValueDomain(definition, 'seals_by_motor', [], [])
    expect(domain.map((option) => option.label)).toEqual(['EPDM', 'Viton', 'PTFE'])
    expect(limitedFeatures(definition, 'seals_by_motor').map((feature) => feature.key)).toEqual(['seal'])

    const row = { match: 'standard', values: ['epdm', 'viton'], default: 'epdm' }
    const withoutDefault = togglePermittedValue(row, 'epdm', domain)
    expect(withoutDefault).toEqual({ match: 'standard', values: ['viton'], default: 'viton' })
    expect(togglePermittedValue(withoutDefault, 'epdm', domain)).toEqual({ match: 'standard', values: ['epdm', 'viton'], default: 'viton' })
    expect(togglePermittedValue({ match: 'x', values: [], default: '' }, 'ptfe', domain)).toEqual({ match: 'x', values: ['ptfe'], default: 'ptfe' })
  })

  it('saves a permitted lookup, dropping options without allowed values and refusing a default that is not allowed', () => {
    const form = lookupToForm(lookupOf('seals_by_motor'), build(), t)
    expect(save(form)).toEqual({ ok: true, lookup: lookupOf('seals_by_motor') })
    const dropped = save({ ...form, permittedRows: [form.permittedRows[0], { match: 'heavy', values: [], default: '' }] })
    expect(dropped.ok && dropped.lookup.rows).toEqual([{ match: 'standard', values: ['epdm', 'viton'], default: 'epdm' }])
    expect(save({ ...form, permittedRows: [{ match: 'standard', values: ['viton'], default: 'epdm' }] })).toEqual({
      ok: false,
      errors: { 'rows.0.default': LOOKUP_ERROR_KEYS.defaultNotAllowed },
    })
  })

  it('keeps matches with surrounding whitespace exactly as stored for both lookup kinds', () => {
    const definition = build((input) => {
      const motor = input.features.find((entry) => entry.key === 'motor')
      motor?.options?.push({ value: 'xl ', label: 'Extra large', order: 3 })
      for (const lookup of input.lookups) {
        if (lookup.key === 'motor_weight' && lookup.kind === 'value') lookup.rows.push({ match: 'xl ', value: 90 })
        if (lookup.key === 'seals_by_motor' && lookup.kind === 'permitted') lookup.rows.push({ match: 'xl ', values: ['ptfe'], default: 'ptfe' })
      }
      input.lookups.push({ kind: 'value', key: 'by_length', keyedBy: 'length', rows: [{ match: ' 9', value: 1 }] })
    })
    for (const key of ['motor_weight', 'seals_by_motor', 'by_length']) {
      const lookup = definition.lookups.find((entry) => entry.key === key)
      const form = lookupToForm(lookup, definition, t)
      const rows = form.kind === 'value' ? form.valueRows : form.permittedRows
      expect(rows.map((row) => row.match)).toEqual(lookup?.rows.map((row) => row.match))
      const result = formToLookup(form, { definition, domain: keyDomain(definition, form.keyedBy, t), otherKeys: [], skuValues: false })
      expect(result).toEqual({ ok: true, lookup })
    }
  })

  it('refuses a typed match with spaces around it unless it is an option, and one that is only whitespace', () => {
    const definition = build((input) => {
      input.features.find((entry) => entry.key === 'motor')?.options?.push({ value: 'xl ', label: 'Extra large', order: 3 })
    })
    const form = lookupToForm(undefined, definition, t)
    const values: LookupFormValues = { ...form, key: 'by_length', keyedBy: 'length', valueRows: [{ match: ' 10 ', text: '5' }] }
    const options = { definition, domain: keyDomain(definition, 'length', t), otherKeys: [], skuValues: false }
    expect(formToLookup(values, options)).toEqual({ ok: false, errors: { 'rows.0.match': LOOKUP_ERROR_KEYS.matchSpaces } })
    expect(formToLookup({ ...values, valueRows: [{ match: '10', text: '5' }] }, options)).toEqual({
      ok: true,
      lookup: { kind: 'value', key: 'by_length', keyedBy: 'length', rows: [{ match: '10', value: 5 }] },
    })
    const byMotor = formToLookup(
      { ...values, keyedBy: 'motor', valueRows: [{ match: 'xl ', text: '5' }, { match: 'heavy ', text: '6' }] },
      { ...options, domain: keyDomain(definition, 'motor', t) },
    )
    expect(byMotor).toEqual({ ok: false, errors: { 'rows.1.match': LOOKUP_ERROR_KEYS.matchSpaces } })
    const storedEdited = lookupToForm(
      { kind: 'value', key: 'by_length', keyedBy: 'length', rows: [{ match: ' 9', value: 1 }] },
      definition,
      t,
    )
    expect(formToLookup({ ...storedEdited, valueRows: [{ ...storedEdited.valueRows[0], match: ' 9 ' }] }, options)).toEqual({
      ok: false,
      errors: { 'rows.0.match': LOOKUP_ERROR_KEYS.matchSpaces },
    })
    expect(formToLookup({ ...values, valueRows: [{ match: '  ', text: '5' }] }, options)).toEqual({
      ok: false,
      errors: { 'rows.0.match': LOOKUP_ERROR_KEYS.required },
    })
    const permitted = lookupToForm(lookupOf('seals_by_motor'), build(), t)
    expect(save({ ...permitted, permittedRows: [...permitted.permittedRows, { match: ' ', values: ['epdm'], default: 'epdm' }] })).toEqual({
      ok: false,
      errors: { 'rows.2.match': LOOKUP_ERROR_KEYS.required },
    })
    expect(save({ ...permitted, permittedRows: [...permitted.permittedRows, { match: 'legacy ', values: ['epdm'], default: 'epdm' }] })).toEqual({
      ok: false,
      errors: { 'rows.2.match': LOOKUP_ERROR_KEYS.matchSpaces },
    })
  })

  it('keeps a stored permitted row without values as stored instead of dropping or refusing it', () => {
    const definition = build((input) => {
      const lookup = input.lookups.find((entry) => entry.key === 'seals_by_motor')
      if (lookup?.kind === 'permitted') {
        lookup.rows = [
          { match: 'standard', values: ['epdm'], default: 'epdm' },
          { match: 'heavy', values: [], default: '' },
          { match: 'legacy', values: [], default: 'viton' },
        ]
      }
    })
    const lookup = definition.lookups.find((entry) => entry.key === 'seals_by_motor')
    const form = lookupToForm(lookup, definition, t)
    expect(form.permittedRows.map((row) => [row.match, row.saved, row.storedEmpty])).toEqual([
      ['standard', true, false],
      ['heavy', true, true],
      ['legacy', true, true],
    ])
    expect(formToLookup(form, { definition, domain: keyDomain(definition, 'motor', t), otherKeys: [], skuValues: false })).toEqual({
      ok: true,
      lookup,
    })
  })

  it('refuses a stored permitted row the admin emptied, and drops an emptied option row', () => {
    const definition = build((input) => {
      const lookup = input.lookups.find((entry) => entry.key === 'seals_by_motor')
      if (lookup?.kind === 'permitted') {
        lookup.rows = [
          { match: 'standard', values: ['epdm'], default: 'epdm' },
          { match: 'legacy', values: ['viton'], default: 'viton' },
        ]
      }
    })
    const form = lookupToForm(definition.lookups.find((entry) => entry.key === 'seals_by_motor'), definition, t)
    const emptied = (match: string) => form.permittedRows.map((row) => (row.match === match ? { ...row, values: [], default: '' } : row))
    const options = { definition, domain: keyDomain(definition, 'motor', t), otherKeys: [], skuValues: false }
    expect(formToLookup({ ...form, permittedRows: emptied('legacy') }, options)).toEqual({
      ok: false,
      errors: { 'rows.1.values': LOOKUP_ERROR_KEYS.valuesRequired },
    })
    const dropped = formToLookup({ ...form, permittedRows: emptied('standard') }, options)
    expect(dropped.ok && dropped.lookup.rows).toEqual([{ match: 'legacy', values: ['viton'], default: 'viton' }])
  })

  it('finds the BOM lines that read SKUs from a lookup', () => {
    expect(skuLineIds(build(), 'motor_skus')).toEqual(['motor'])
    expect(skuLineIds(build(), 'motor_weight')).toEqual([])
  })
})
