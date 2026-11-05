import { extractPlaceholders, renderMessage } from '../messages'
import { build } from './fixtures'

const definition = build()

describe('messages', () => {
  it('extracts feature, formula, lookup and line placeholders', () => {
    expect(extractPlaceholders('{feature.motor} {formula.weight} {lookup.motor_weight} {line.cover_line.total} {other}')).toEqual([
      { kind: 'feature', key: 'motor', token: '{feature.motor}' },
      { kind: 'formula', key: 'weight', token: '{formula.weight}' },
      { kind: 'lookup', key: 'motor_weight', token: '{lookup.motor_weight}' },
      { kind: 'line', bomId: 'cover_line', token: '{line.cover_line.total}' },
    ])
  })

  it('renders option labels, formula decimals, lookup values and line totals as plain text', () => {
    const text = renderMessage(
      '<b>{feature.motor}</b>: {formula.weight} kg, {feature.length} m, seals {lookup.seals_by_motor}, cover {line.cover_line.total}',
      {
        definition,
        params: {
          'feature.motor': 'heavy',
          'formula.weight': 131,
          'feature.length': 12.5,
          'lookup.seals_by_motor': ['viton', 'ptfe'],
        },
        locale: 'en',
        pricedBom: [{ bomId: 'cover_line', total: '1099.95' }],
      },
    )
    expect(text).toBe('<b>Heavy duty 7 kW</b>: 131.0 kg, 12.5 m, seals viton, ptfe, cover €1,099.95')
  })

  it('keeps unresolved placeholders literal', () => {
    expect(
      renderMessage('{feature.ghost} {line.none.total} {lookup.motor_weight}', {
        definition,
        params: { 'lookup.motor_weight': null },
        locale: 'en',
      }),
    ).toBe('{feature.ghost} {line.none.total} {lookup.motor_weight}')
  })

  it('formats numbers with the given locale', () => {
    expect(
      renderMessage('{formula.pipe_meters}', { definition, params: { 'formula.pipe_meters': 1234.5 }, locale: 'de' }),
    ).toBe('1.234,50')
  })
})
