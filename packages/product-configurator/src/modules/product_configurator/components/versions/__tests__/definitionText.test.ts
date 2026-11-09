import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { BomLineDefinition, Feature } from '../../../data/validators'
import { formatAction, formatBomQuantity, formatBomSku, formatConditions, formatFeatureValues } from '../definitionText'

const t: TranslateFn = (key, fallback, params) => {
  const text = typeof fallback === 'string' ? fallback : key
  return params ? text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? '')) : text
}

describe('definitionText', () => {
  it('formats every condition kind and joins them with and', () => {
    expect(formatConditions(undefined, t)).toBe('Always')
    expect(
      formatConditions(
        [
          { kind: 'compare', featureKey: 'cab', op: 'neq', value: 'open' },
          { kind: 'calculated', formulaKey: 'hose_m', op: 'gte', value: 25 },
          { kind: 'includes', featureKey: 'extras', value: 'lights' },
          { kind: 'not_includes', featureKey: 'extras', value: 'horn' },
          { kind: 'not_in_lookup', featureKey: 'boom', lookupKey: 'boom_hitch', keyedBy: 'attachment' },
        ],
        t,
      ),
    ).toBe(
      'feature.cab != "open" and formula.hose_m >= 25 and feature.extras includes "lights" and feature.extras does not include "horn" and feature.boom is not in lookup boom_hitch (by attachment)',
    )
  })

  it('formats force actions', () => {
    expect(formatAction(undefined, t)).toBe('')
    expect(formatAction({ kind: 'set', featureKey: 'aux', value: true }, t)).toBe('feature.aux := true')
    expect(formatAction({ kind: 'map', featureKey: 'paint', from: { red: 'yellow' } }, t)).toBe('Map feature.paint: "red" -> "yellow"')
    expect(formatAction({ kind: 'lookup_default', featureKey: 'hitch', lookupKey: 'hitches', keyedBy: 'attachment' }, t)).toBe(
      'Default of lookup hitches by attachment into feature.hitch',
    )
  })

  it('formats feature values by type, options in their order', () => {
    const base: Feature = { key: 'paint', label: 'Paint', type: 'choice', default: 'b', order: 1, inSummary: true }
    expect(
      formatFeatureValues({ ...base, options: [{ value: 'b', label: 'Blue', order: 2 }, { value: 'a', label: 'Amber', order: 1 }] }, t),
    ).toEqual(['Amber, Blue'])
    expect(formatFeatureValues({ ...base, optionsFromLookup: 'paints' }, t)).toEqual(['From lookup paints'])
    expect(formatFeatureValues({ ...base, type: 'number', default: 2, min: 1, max: 10, step: 0.5, unit: 'm' }, t)).toEqual([
      'Min 1',
      'Max 10',
      'Step 0.5',
    ])
    expect(formatFeatureValues({ ...base, type: 'boolean', default: false }, t)).toEqual([])
  })

  it('lists the options and the lookup reference when a feature has both', () => {
    const feature: Feature = {
      key: 'boom',
      label: 'Boom',
      type: 'choice',
      default: 'short',
      order: 1,
      inSummary: true,
      options: [{ value: 'short', label: 'Short', order: 1 }],
      optionsFromLookup: 'boom_hitch',
    }
    expect(formatFeatureValues(feature, t)).toEqual(['Short', 'From lookup boom_hitch'])
  })

  it('formats BOM SKUs and quantities', () => {
    const line: BomLineDefinition = { id: 'boom', sku: 'TH-BOOM-10', uom: 'pc', quantity: 1, when: [], order: 1 }
    expect(formatBomSku(line, t)).toBe('TH-BOOM-10')
    expect(formatBomQuantity(line)).toBe('1')
    const fromLookup: BomLineDefinition = {
      id: 'hose',
      skuFromLookup: { lookupKey: 'hoses', keyedBy: 'boom' },
      uom: 'm',
      quantity: { formulaKey: 'hose_m' },
      when: [],
      order: 2,
    }
    expect(formatBomSku(fromLookup, t)).toBe('From lookup hoses by boom')
    expect(formatBomQuantity(fromLookup)).toBe('formula.hose_m')
  })
})
