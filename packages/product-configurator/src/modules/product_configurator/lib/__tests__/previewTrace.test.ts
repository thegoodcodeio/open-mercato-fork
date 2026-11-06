import { buildFiredRules } from '../previewTrace'
import { build } from './fixtures'

describe('buildFiredRules', () => {
  it('lists force, error, warning and surcharge rules that applied, once each, in rule order', () => {
    const definition = build((input) => {
      input.rules = [
        { id: 'surcharge', label: 'Paint', effect: 'surcharge', when: [], messageTemplate: '', featureKeys: [], order: 4 },
        { id: 'block', label: 'Too long', effect: 'error', when: [], messageTemplate: '', featureKeys: [], order: 2 },
        { id: 'force', effect: 'force', when: [], action: { kind: 'set', featureKey: 'cover', value: true }, messageTemplate: '', featureKeys: [], order: 1 },
        { id: 'quiet', effect: 'warning', when: [], messageTemplate: '', featureKeys: [], order: 3 },
      ]
    })
    const fired = buildFiredRules(definition, {
      forced: [{ featureKey: 'cover', ruleId: 'force', from: false, to: true }],
      errors: [
        { ruleId: 'block', params: {} },
        { ruleId: 'block', params: {} },
        { code: 'option_not_available', params: { featureKey: 'seal' } },
      ],
      warnings: [],
      surcharges: [{ ruleId: 'surcharge', bomId: 'pipe', params: {} }],
    })
    expect(fired).toEqual([
      { ruleId: 'force', label: null, effect: 'force' },
      { ruleId: 'block', label: 'Too long', effect: 'error' },
      { ruleId: 'surcharge', label: 'Paint', effect: 'surcharge' },
    ])
  })
})
