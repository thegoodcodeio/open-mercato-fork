import {
  DEFINITION_LIMITS,
  definitionSchema,
  rawSelectionsSchema,
  type ConfigurationDefinitionInput,
} from '../../data/validators'
import { choiceFeature, referenceInput, setRule } from './fixtures'

function issuesOf(mutate: (input: ConfigurationDefinitionInput) => void): string[] {
  const input = referenceInput()
  mutate(input)
  const result = definitionSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}:${issue.message}`)
}

function repeat<Item>(count: number, create: (index: number) => Item): Item[] {
  return Array.from({ length: count }, (_, index) => create(index))
}

describe('definitionSchema', () => {
  it('accepts the reference definition and defaults allowPromotions to false', () => {
    const parsed = definitionSchema.parse(referenceInput())
    expect(parsed.commercial.allowPromotions).toBe(false)
    expect(parsed.schemaVersion).toBe(1)
  })

  it('enforces collection limits', () => {
    expect(issuesOf((input) => (input.features = repeat(DEFINITION_LIMITS.features + 1, (i) => choiceFeature(`f${i}`, i))))).toEqual([
      expect.stringMatching(/^features:too_big/),
    ])
    expect(
      issuesOf((input) => (input.rules = repeat(DEFINITION_LIMITS.rules + 1, (i) => setRule(`R${i}`, i, { featureKey: 'motor', value: 'x' }, { featureKey: 'color', value: 'red' })))),
    ).toEqual([expect.stringMatching(/^rules:too_big/)])
    expect(
      issuesOf((input) => (input.formulas = repeat(DEFINITION_LIMITS.formulas + 1, (i) => ({ key: `k${i}`, expr: { kind: 'const', value: 1 } })))),
    ).toEqual([expect.stringMatching(/^formulas:too_big/)])
    expect(
      issuesOf((input) => (input.lookups = repeat(DEFINITION_LIMITS.lookups + 1, (i) => ({ kind: 'value', key: `l${i}`, keyedBy: 'motor', rows: [] })))),
    ).toEqual([expect.stringMatching(/^lookups:too_big/)])
    expect(
      issuesOf((input) => {
        input.lookups[0].rows = repeat(DEFINITION_LIMITS.lookupRows + 1, (i) => ({ match: `m${i}`, values: [], default: '' }))
      }),
    ).toEqual([expect.stringMatching(/^lookups\.0\.rows:too_big/)])
    expect(
      issuesOf((input) => (input.bom = repeat(DEFINITION_LIMITS.bomLines + 1, (i) => ({ id: `b${i}`, sku: 'S', uom: 'pcs', quantity: 1, when: [], order: i })))),
    ).toEqual([expect.stringMatching(/^bom:too_big/)])
    expect(
      issuesOf((input) => {
        input.rules = [
          {
            ...setRule('R', 1, { featureKey: 'motor', value: 'x' }, { featureKey: 'color', value: 'red' }),
            when: repeat(DEFINITION_LIMITS.conditionsPerRule + 1, () => ({ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'x' })),
          },
        ]
      }),
    ).toEqual([expect.stringMatching(/^rules\.0\.when:too_big/)])
  })

  it('rejects a definition above 512 KB before parsing its content', () => {
    const issues = issuesOf((input) => {
      input.fixedSpecification = [{ label: 'Notes', value: 'x'.repeat(DEFINITION_LIMITS.definitionBytes) }]
    })
    expect(issues).toEqual([':custom:too_large'])
  })

  it('requires an action for force rules only', () => {
    expect(
      issuesOf((input) => {
        input.rules = [{ id: 'F', effect: 'force', when: [], messageTemplate: '', featureKeys: [], order: 1 }]
      }),
    ).toEqual(['rules.0.action:custom:action_required'])
    expect(
      issuesOf((input) => {
        input.rules = [{ ...setRule('E', 1, { featureKey: 'motor', value: 'x' }, { featureKey: 'color', value: 'red' }), effect: 'error' }]
      }),
    ).toEqual(['rules.0.action:custom:action_not_allowed'])
  })

  it('validates feature shapes', () => {
    expect(
      issuesOf((input) => {
        const color = input.features.find((feature) => feature.key === 'color')
        if (color?.options) color.options[0] = { value: 'red', label: 'Red', order: 1 }
      }),
    ).toEqual(['features.3.options.0.swatch:custom:swatch_required'])
    expect(
      issuesOf((input) => {
        const color = input.features.find((feature) => feature.key === 'color')
        if (color?.options) color.options[0].swatch = 'red'
      }),
    ).toEqual([expect.stringMatching(/^features\.3\.options\.0\.swatch:invalid_format/)])
    expect(issuesOf((input) => (input.features[1].default = '2'))).toEqual(['features.1.default:custom:default_type_mismatch'])
    expect(issuesOf((input) => delete input.features[0].options)).toEqual(['features.0.options:custom:options_required'])
    expect(issuesOf((input) => (input.features[1].max = 0))).toEqual(['features.1.min:custom:min_above_max'])
  })

  it('validates conditions, BOM lines and keys', () => {
    expect(
      issuesOf((input) => {
        input.features[5].visibleWhen = [{ kind: 'compare', featureKey: 'motor', op: 'gt', value: 'heavy' }]
      }),
    ).toEqual(['features.5.visibleWhen.0.value:custom:ordering_value_not_numeric'])
    expect(
      issuesOf((input) => {
        input.features[5].visibleWhen = [{ kind: 'includes', featureKey: 'motor', value: 'rear front' }]
      }),
    ).toEqual(['features.5.visibleWhen.0.value:custom:single_token_required'])
    expect(
      issuesOf((input) => {
        input.bom[0] = { ...input.bom[0], skuFromLookup: { lookupKey: 'motor_skus', keyedBy: 'motor' } }
      }),
    ).toEqual(['bom.0.sku:custom:sku_or_sku_from_lookup_required'])
    expect(issuesOf((input) => (input.features[0].key = 'bad key'))).toEqual([expect.stringMatching(/^features\.0\.key:invalid_format/)])
  })

  it('rejects unknown properties', () => {
    const input = { ...referenceInput(), extra: true }
    expect(definitionSchema.safeParse(input).success).toBe(false)
  })
})

describe('rawSelectionsSchema', () => {
  it('accepts scalar selections and rejects a request above 64 KB', () => {
    expect(rawSelectionsSchema.safeParse({ motor: 'heavy', length: 2, cover: true, seal: null }).success).toBe(true)
    expect(rawSelectionsSchema.safeParse({ motor: { nested: true } }).success).toBe(false)
    expect(rawSelectionsSchema.safeParse({ notes: 'x'.repeat(DEFINITION_LIMITS.evaluateRequestBytes) }).success).toBe(false)
  })
})

describe('definitionSchema: keys inherited from Object.prototype', () => {
  it.each(['constructor', 'toString', '__proto__'])('rejects %s as a feature, formula or lookup key', (reserved) => {
    expect(
      issuesOf((input) => {
        input.features.push({ ...choiceFeature(reserved, 99) })
        input.formulas.push({ key: reserved, expr: { kind: 'const', value: 1 } })
        input.lookups.push({ kind: 'value', key: reserved, keyedBy: 'motor', rows: [] })
      }),
    ).toEqual([
      expect.stringMatching(/:custom:reserved_key$/),
      expect.stringMatching(/:custom:reserved_key$/),
      expect.stringMatching(/:custom:reserved_key$/),
    ])
  })

  it('still accepts keys that only contain a reserved name', () => {
    expect(issuesOf((input) => input.features.push(choiceFeature('constructor_type', 99)))).toEqual([])
  })
})
