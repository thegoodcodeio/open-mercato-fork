import { buildSummary, SUMMARY_MAX_LENGTH } from '../summary'
import { build, structureOf } from './fixtures'

function summaryFor(definition = build(), selections = {}, locale = 'en') {
  const structure = structureOf(definition, selections)
  return buildSummary({ definition, selections: structure.selections, visibility: structure.visibility, locale })
}

describe('buildSummary', () => {
  it('lists visible inSummary features in order with option labels and units', () => {
    expect(summaryFor()).toBe('Motor: Standard 3 kW; Pipe length: 2 m; Seal: EPDM')
  })

  it('shows a boolean only when true, as its label, and leaves out hidden features', () => {
    expect(summaryFor(build(), { cover: true, remote: true })).toBe(
      'Motor: Standard 3 kW; Pipe length: 2 m; Weather cover; Seal: EPDM',
    )
    expect(summaryFor(build(), { motor: 'heavy', seal: 'viton', remote: true })).toBe(
      'Motor: Heavy duty 7 kW; Pipe length: 2 m; Seal: Viton; Remote control',
    )
  })

  it('formats numbers in the given locale and follows feature order, not array order', () => {
    const definition = build((input) => {
      const length = input.features.find((feature) => feature.key === 'length')
      if (length) {
        length.max = 2000
        length.order = 0
      }
    })
    expect(summaryFor(definition, { length: 1234.5 }, 'de')).toBe('Pipe length: 1.234,5 m; Motor: Standard 3 kW; Seal: EPDM')
  })

  it('cuts at the last whole entry within the character limit', () => {
    const definition = build((input) => {
      input.features = Array.from({ length: 30 }, (_, index) => ({
        key: `f${index}`,
        label: `Feature ${index} ${'x'.repeat(40)}`,
        type: 'boolean' as const,
        default: true,
        order: index,
        inSummary: true,
      }))
      input.lookups = []
      input.formulas = []
      input.bom = []
    })
    const summary = summaryFor(definition)
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH)
    const entries = summary.split('; ')
    expect(entries.every((entry) => /^Feature \d+ x{40}$/.test(entry))).toBe(true)
    const nextEntry = `Feature ${entries.length} ${'x'.repeat(40)}`
    expect(`${summary}; ${nextEntry}`.length).toBeGreaterThan(SUMMARY_MAX_LENGTH)
  })
})
