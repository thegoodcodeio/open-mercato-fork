/** @jest-environment node */
import { ConfigurationSnapshot } from '../../data/entities'
import { definitionSchema, type ConfigurationDefinition } from '../../data/validators'
import { buildSnapshotReadModel, linesBySnapshot } from '../snapshots'
import type { StoredLine } from '../quoteAccess'

const LONG_RULE_LABEL = 'Long cable'

const definition: ConfigurationDefinition = definitionSchema.parse({
  schemaVersion: 1,
  commercial: { currencyCode: 'EUR', priceKindId: '11111111-1111-4111-8111-111111111111', allowPromotions: false },
  fixedSpecification: [{ label: 'Warranty', value: '2 years' }],
  features: [
    {
      key: 'size',
      label: 'Size',
      type: 'choice',
      options: [
        { value: 's', label: 'Small', order: 1 },
        { value: 'l', label: 'Large', order: 2 },
      ],
      default: 's',
      order: 2,
      inSummary: true,
    },
    { key: 'length', label: 'Length', type: 'number', unit: 'm', default: 1, order: 1, inSummary: true },
    { key: 'hidden', label: 'Hidden', type: 'boolean', default: false, order: 3, inSummary: false },
  ],
  rules: [
    { id: 'long', label: LONG_RULE_LABEL, effect: 'warning', when: [], messageTemplate: 'Length {feature.length} needs {line.cable.total}', featureKeys: ['length'], order: 1 },
  ],
  formulas: [
    { key: 'cable', label: 'Cable', expr: { kind: 'const', value: 2 }, unit: 'm' },
    { key: 'internal', expr: { kind: 'const', value: 1 } },
  ],
  lookups: [],
  bom: [],
})

function snapshot(): ConfigurationSnapshot {
  return Object.assign(new ConfigurationSnapshot(), {
    id: 'snapshot-1',
    sessionId: 'session-1',
    quoteId: 'quote-1',
    quoteLineId: 'line-1',
    modelVersionId: 'version-1',
    modelVersionHash: 'v'.repeat(64),
    selections: { intent: { size: 'l' }, settled: { size: 'l', length: 2.5, hidden: true }, visibility: { size: true, length: true, hidden: false } },
    calculated: { cable: 2, internal: 1 },
    bom: [{ bomId: 'cable', sku: 'CAB', label: 'Cable', quantity: '2', uom: 'm', unitPrice: '3.5000', total: '7.00' }],
    warnings: [{ ruleId: 'long', params: { 'feature.length': 2.5 } }],
    priceContext: {},
    netPrice: '7.0000',
    currencyCode: 'EUR',
    summary: 'Length: 2.5 m; Size: Large',
    hash: 'h'.repeat(64),
    createdAt: new Date('2026-11-06T10:00:00.000Z'),
  })
}

describe('buildSnapshotReadModel', () => {
  it('renders visible features in order, labelled formulas, the specification, BOM and rendered warnings', () => {
    const model = buildSnapshotReadModel({
      snapshot: snapshot(),
      definition,
      version: 4,
      modelTitle: 'Pump',
      line: { state: 'present', name: 'Pump for site B' },
      locale: 'en',
    })
    expect(model).toMatchObject({
      id: 'snapshot-1',
      lineState: 'present',
      lineName: 'Pump for site B',
      modelTitle: 'Pump',
      modelVersion: { id: 'version-1', version: 4, hash: 'v'.repeat(64) },
      selectionRows: [
        { label: 'Length', value: 2.5, unit: 'm' },
        { label: 'Size', value: 'Large', unit: null },
      ],
      calculatedRows: [{ label: 'Cable', value: 2, unit: 'm' }],
      specification: [{ label: 'Warranty', value: '2 years' }],
      bom: [{ sku: 'CAB', label: 'Cable', quantity: '2', uom: 'm', unitPrice: '3.5000', total: '7.00' }],
      netPrice: '7.0000',
      warnings: [{ ruleId: 'long', label: LONG_RULE_LABEL, message: 'Length 2.5 needs €7.00' }],
      createdAt: '2026-11-06T10:00:00.000Z',
    })
  })

  it('degrades to raw data without a readable definition', () => {
    const model = buildSnapshotReadModel({ snapshot: snapshot(), definition: null, version: null, modelTitle: null, line: { state: 'removed', name: null }, locale: 'en' })
    expect(model.selectionRows).toEqual([])
    expect(model.warnings).toEqual([{ ruleId: 'long', label: null, message: '' }])
    expect(model.lineState).toBe('removed')
  })
})

describe('linesBySnapshot', () => {
  it('maps each snapshot to the first line carrying its marker', () => {
    const line = (id: string, configuration: Record<string, unknown> | null) => ({ id, configuration }) as unknown as StoredLine
    const carried = linesBySnapshot([
      line('a', null),
      line('b', { productConfigurator: { snapshotId: 's-1' } }),
      line('c', { productConfigurator: { snapshotId: 's-1' } }),
      line('d', { other: true }),
    ])
    expect([...carried.entries()].map(([snapshotId, entry]) => [snapshotId, entry.id])).toEqual([['s-1', 'b']])
  })
})
