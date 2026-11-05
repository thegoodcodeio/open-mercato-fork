import type { ConfigurationDefinitionInput } from '../../data/validators'
import { MAX_SETTLE_PASSES } from '../evaluator/structure'
import { choiceFeature, setRule } from './fixtures'
import { validate } from './validationFixtures'

function onlyFeatures(input: ConfigurationDefinitionInput, features: ConfigurationDefinitionInput['features']) {
  input.features = features
  input.formulas = []
  input.lookups = []
  input.bom = []
}

function chain(length: number) {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, length + 1)
  return (input: ConfigurationDefinitionInput) => {
    onlyFeatures(input, keys.map((key, index) => choiceFeature(key, index + 1)))
    input.rules = keys
      .slice(0, length)
      .map((key, index) =>
        setRule(`CHAIN-${index}`, length - index, { featureKey: key, value: 'y' }, { featureKey: keys[index + 1], value: 'y' }),
      )
  }
}

describe('validateForPublication: fixed_point', () => {
  it('accepts force rules that settle within the pass limit, including a rule that corrects its own target', async () => {
    expect((await validate(chain(MAX_SETTLE_PASSES))).ok).toBe(true)
    const report = await validate((input) => {
      input.rules = [
        {
          id: 'SEAL',
          effect: 'force',
          when: [{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }],
          action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' },
          messageTemplate: '',
          featureKeys: ['seal'],
          order: 1,
        },
      ]
    })
    expect(report.ok).toBe(true)
  })

  it('reports rules that need more passes than the evaluator allows', async () => {
    const report = await validate(chain(MAX_SETTLE_PASSES + 1))
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ check: 'fixed_point', code: 'fixed_point_not_reached' })
    expect(report.issues[0].refs).toContainEqual({ kind: 'feature', key: 'e' })
  })

  it('reports rules that oscillate through visibleWhen', async () => {
    const report = await validate((input) => {
      onlyFeatures(input, [choiceFeature('a', 1), { ...choiceFeature('b', 2), visibleWhen: [{ kind: 'compare', featureKey: 'a', op: 'eq', value: 'x' }] }])
      input.rules = [
        setRule('TO_Y', 1, { featureKey: 'b', value: 'y' }, { featureKey: 'a', value: 'y' }),
        setRule('TO_X', 2, { featureKey: 'b', value: 'x' }, { featureKey: 'a', value: 'x' }),
      ]
    })
    expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
      ['fixed_point', 'fixed_point_not_reached', { ruleIds: ['TO_X', 'TO_Y'], featureKeys: ['a', 'b'] }],
    ])
  })

  it('reports rules that oscillate through a calculated condition', async () => {
    const report = await validate((input) => {
      onlyFeatures(input, [
        { key: 'n', label: 'N', type: 'number', min: 0, max: 1, step: 1, default: 0, order: 1, inSummary: false },
        { ...choiceFeature('b', 2), visibleWhen: [{ kind: 'calculated', formulaKey: 'level', op: 'lt', value: 1 }] },
      ])
      input.formulas = [{ key: 'level', expr: { kind: 'feature', featureKey: 'n' } }]
      input.rules = [
        setRule('UP', 1, { featureKey: 'b', value: 'y' }, { featureKey: 'n', value: 1 }),
        setRule('DOWN', 2, { featureKey: 'b', value: 'x' }, { featureKey: 'n', value: 0 }),
      ]
    })
    expect(report.issues.map((issue) => [issue.check, issue.code])).toEqual([['fixed_point', 'fixed_point_not_reached']])
  })
})
