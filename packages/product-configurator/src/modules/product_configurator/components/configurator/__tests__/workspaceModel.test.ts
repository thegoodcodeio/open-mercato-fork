import { TextEncoder } from 'node:util'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { build } from '../../../lib/__tests__/fixtures'
import { failureFromResponse, type WorkspaceEvaluation } from '../evaluationSchema'
import { checkNumberInput, featureGroups, featureOptions, pruneSelections, workspaceMessages } from '../workspaceModel'

Object.assign(globalThis, { TextEncoder })

const t: TranslateFn = (key, fallbackOrParams, params) => {
  const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined
  const values = typeof fallbackOrParams === 'object' ? fallbackOrParams : params
  return (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (values && name in values ? String(values[name]) : token))
}

function evaluation(overrides: Partial<WorkspaceEvaluation> = {}): WorkspaceEvaluation {
  return {
    selections: {},
    visibility: {},
    forced: [],
    availability: {},
    errors: [],
    warnings: [],
    surcharges: [],
    finalisable: true,
    bom: [{ bomId: 'pipe', sku: 'PIPE-M', label: 'Pipe', quantity: '2.25', uom: 'm', unitPrice: '12.3456', total: '27.78' }],
    netPrice: '27.78',
    currencyCode: 'EUR',
    hash: 'h',
    ...overrides,
  }
}

describe('workspace model', () => {
  const definition = build((input) => {
    input.features[0].group = 'Drive'
    input.features[1].group = 'Piping'
    input.rules = [
      { id: 'w1', label: 'Long pipe', effect: 'warning', when: [], messageTemplate: 'Pipe {formula.pipe_meters} m', featureKeys: ['length'], order: 1 },
      { id: 's1', effect: 'surcharge', when: [], messageTemplate: 'Pipe adds {line.pipe.total}', featureKeys: [], order: 2 },
      { id: 'f1', label: 'Cover for heavy', effect: 'force', when: [], action: { kind: 'set', featureKey: 'cover', value: true }, messageTemplate: '', featureKeys: [], order: 3 },
    ]
  })

  it('groups visible features in order and leaves hidden ones out', () => {
    const groups = featureGroups(definition, { remote: false })
    expect(groups.map((group) => [group.name, group.features.map((feature) => feature.key)])).toEqual([
      ['Drive', ['motor']],
      ['Piping', ['length']],
      [null, ['cover', 'color', 'seal']],
    ])
  })

  it('takes options from the feature, or from its permitted lookup when it has none', () => {
    expect(featureOptions(definition, definition.features[4]).map((option) => option.label)).toEqual(['EPDM', 'Viton', 'PTFE'])
    const fromLookup = build((input) => {
      delete input.features[4].options
    })
    expect(featureOptions(fromLookup, fromLookup.features[4]).map((option) => option.value)).toEqual(['epdm', 'viton', 'ptfe'])
  })

  it('checks numbers like the evaluator: type, range and decimal step', () => {
    const length = definition.features[1]
    expect(checkNumberInput(length, '2.5')).toEqual({ ok: true, value: 2.5 })
    expect(checkNumberInput(length, '2,5')).toEqual({ ok: true, value: 2.5 })
    expect(checkNumberInput(length, 'abc')).toEqual({ ok: false, reason: 'type' })
    expect(checkNumberInput(length, '0.5')).toEqual({ ok: false, reason: 'below_min' })
    expect(checkNumberInput(length, '21')).toEqual({ ok: false, reason: 'above_max' })
    expect(checkNumberInput(length, '2.3')).toEqual({ ok: false, reason: 'step' })
  })

  it('drops choices for features the draft no longer has', () => {
    expect(pruneSelections(definition, { motor: 'heavy', gone: 1 })).toEqual({ motor: 'heavy' })
  })

  it('renders rule and system messages with links to their fields', () => {
    const messages = workspaceMessages(
      definition,
      evaluation({
        errors: [{ code: 'option_not_available', params: { featureKey: 'seal', value: 'ptfe' } }],
        warnings: [{ ruleId: 'w1', params: { 'formula.pipe_meters': 2.25 } }],
        surcharges: [{ ruleId: 's1', bomId: 'pipe', params: {} }],
        forced: [{ featureKey: 'cover', ruleId: 'f1', from: false, to: true }],
      }),
      'en',
      t,
    )
    expect(messages.map((message) => [message.severity, message.text, message.featureKeys])).toEqual([
      ['error', 'Seal: ptfe is not available with the current choices.', ['seal']],
      ['warning', 'Pipe 2.25 m', ['length']],
      ['info', 'Pipe adds €27.78', []],
      ['info', 'Set automatically (Cover for heavy): Weather cover is Yes.', ['cover']],
    ])
  })

  it('maps error responses to workspace failures; only server errors are transient', () => {
    expect(failureFromResponse(503, null)).toEqual({ kind: 'transient' })
    expect(failureFromResponse(422, { code: 'invalid_selection', issues: [{ featureKey: 'length', reason: 'step', value: 2.3 }] })).toEqual({
      kind: 'selection',
      issues: [{ featureKey: 'length', reason: 'step', value: 2.3 }],
    })
    expect(failureFromResponse(422, { code: 'price_missing', params: { skus: ['A'], channelId: 'c1' } })).toEqual({
      kind: 'price_missing',
      skus: ['A'],
      channelId: 'c1',
    })
    expect(failureFromResponse(422, { code: 'expression_error', params: { formulaKey: 'x' } })).toEqual({
      kind: 'model_fix',
      code: 'expression_error',
      params: { formulaKey: 'x' },
    })
    expect(failureFromResponse(404, { error: 'Configuration model not found.', code: 'model_not_found' })).toEqual({
      kind: 'other',
      status: 404,
      code: 'model_not_found',
      message: 'Configuration model not found.',
    })
  })
})
