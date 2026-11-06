import { TextEncoder } from 'node:util'
import { definitionSchema, type Feature } from '../../../data/validators'
import { build } from '../../../lib/__tests__/fixtures'
import { buildReferenceDefinition } from '../../../lib/referenceModel'
import { FEATURE_ERROR_KEYS, featureToForm, formToFeature } from '../tabs/featureForm'

Object.assign(globalThis, { TextEncoder })

describe('feature row editor form', () => {
  const definition = build()

  it('round-trips every feature of the reference model', () => {
    for (const feature of definition.features) {
      const result = formToFeature(featureToForm(feature, 100), [])
      expect(result).toEqual({ ok: true, feature })
    }
  })

  it('round-trips every feature of the seeded reference model unchanged, the unit of a choice feature included', () => {
    const reference = definitionSchema.parse(buildReferenceDefinition({ currencyCode: 'EUR', priceKindId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60' }))
    expect(reference.features.some((feature) => feature.type === 'choice' && feature.unit)).toBe(true)
    for (const feature of reference.features) {
      const result = formToFeature(featureToForm(feature, 100), [], feature)
      expect(result).toEqual({ ok: true, feature })
    }
  })

  it('keeps a swatch on a choice option', () => {
    const feature: Feature = {
      key: 'trim',
      label: 'Trim',
      type: 'choice',
      options: [{ value: 'oak', label: 'Oak', order: 1, swatch: '#8B5A2B' }],
      default: 'oak',
      order: 1,
      inSummary: true,
    }
    expect(formToFeature(featureToForm(feature, 10), [], feature)).toEqual({ ok: true, feature })
  })

  it('saves an untouched feature as is: option order, empty lists and option values', () => {
    const feature: Feature = {
      key: 'boom',
      label: 'Boom',
      type: 'choice',
      options: [
        { value: 'long ', label: 'Long', order: 2 },
        { value: 'short', label: 'Short', order: 1 },
      ],
      default: 'short',
      order: 1,
      inSummary: true,
      visibleWhen: [],
    }
    expect(formToFeature(featureToForm(feature, 10), [], feature)).toEqual({ ok: true, feature })
    const fromLookup: Feature = { ...feature, options: [], optionsFromLookup: 'boom_hitch' }
    expect(formToFeature(featureToForm(fromLookup, 10), [], fromLookup)).toEqual({ ok: true, feature: fromLookup })
  })

  it('drops empty lists the user emptied when the original had entries', () => {
    const feature: Feature = {
      key: 'heater',
      label: 'Heater',
      type: 'boolean',
      default: false,
      order: 1,
      inSummary: true,
      visibleWhen: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }],
    }
    const result = formToFeature({ ...featureToForm(feature, 10), visibleWhen: [] }, [], feature)
    expect(result.ok && result.feature.visibleWhen).toBeUndefined()
  })

  it('accepts plain decimal numbers only', () => {
    const base = { ...featureToForm(undefined, 10), label: 'Height', key: 'height', type: 'number' as const, defaultValue: '2' }
    for (const raw of ['0x10', ' ', '1e', 'Infinity', '1,5']) {
      expect(formToFeature({ ...base, min: raw }, [])).toEqual(raw.trim() ? { ok: false, errors: { min: FEATURE_ERROR_KEYS.number } } : expect.objectContaining({ ok: true }))
    }
    expect(formToFeature({ ...base, defaultValue: '0x10' }, [])).toEqual({ ok: false, errors: { default: FEATURE_ERROR_KEYS.number } })
    expect(formToFeature({ ...base, defaultValue: ' ' }, [])).toEqual({ ok: false, errors: { default: FEATURE_ERROR_KEYS.number } })
    expect(formToFeature({ ...base, order: '0x10' }, [])).toEqual({ ok: false, errors: { order: FEATURE_ERROR_KEYS.integer } })
    const parsed = formToFeature({ ...base, min: '-1.5', max: '1e3', step: '0.25' }, [])
    expect(parsed.ok && [parsed.feature.min, parsed.feature.max, parsed.feature.step]).toEqual([-1.5, 1000, 0.25])
  })

  it('builds a colour feature with swatches and suggested option values', () => {
    const values = {
      ...featureToForm(undefined, 10),
      label: 'Custom colour',
      key: 'custom_colour',
      type: 'color' as const,
      options: [{ label: 'Signal red', value: '', swatch: '#C0392B', order: '1' }],
      defaultValue: 'signal_red',
    }
    const result = formToFeature(values, [])
    expect(result.ok && result.feature.options).toEqual([{ value: 'signal_red', label: 'Signal red', order: 1, swatch: '#C0392B' }])
  })

  it('reports field errors instead of building an invalid feature', () => {
    const values = {
      ...featureToForm(undefined, 10),
      label: 'Paint',
      key: 'motor',
      type: 'color' as const,
      options: [{ label: 'Red', value: 'red', swatch: 'red', order: 'x' }],
    }
    const result = formToFeature(values, ['motor'])
    expect(result).toEqual({
      ok: false,
      errors: {
        key: FEATURE_ERROR_KEYS.duplicateKey,
        'options.0.order': FEATURE_ERROR_KEYS.integer,
        'options.0.swatch': FEATURE_ERROR_KEYS.swatch,
      },
    })
  })

  it('needs a number default and a valid key for number features', () => {
    const values = { ...featureToForm(undefined, 10), label: 'Height', key: '1height', type: 'number' as const, defaultValue: '' }
    const result = formToFeature(values, [])
    expect(result.ok).toBe(false)
    const second = formToFeature({ ...values, defaultValue: '3' }, [])
    expect(second).toEqual({ ok: false, errors: { key: FEATURE_ERROR_KEYS.invalidKey } })
  })

  it('needs a number default inside the range and on the step', () => {
    const values = { ...featureToForm(undefined, 10), label: 'Outreach', key: 'outreach', type: 'number' as const, min: '7', max: '12', step: '0.5' }
    expect(formToFeature({ ...values, defaultValue: '8.3' }, [])).toEqual({ ok: false, errors: { default: FEATURE_ERROR_KEYS.defaultOffStep } })
    expect(formToFeature({ ...values, defaultValue: '13' }, [])).toEqual({ ok: false, errors: { default: FEATURE_ERROR_KEYS.defaultOutOfRange } })
    expect(formToFeature({ ...values, defaultValue: '6.5' }, [])).toEqual({ ok: false, errors: { default: FEATURE_ERROR_KEYS.defaultOutOfRange } })
    const valid = formToFeature({ ...values, defaultValue: '8.5' }, [])
    expect(valid.ok && valid.feature.default).toBe(8.5)
  })
})
