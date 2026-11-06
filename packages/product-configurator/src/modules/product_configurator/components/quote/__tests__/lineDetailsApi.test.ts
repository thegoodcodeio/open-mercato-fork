import {
  TAX_KEEP,
  TAX_NONE,
  buildLineUpdateBody,
  initialLineForm,
  parseDecimalInput,
  parseQuoteLine,
  parseTaxRates,
  validateLineForm,
  type QuoteLineDetails,
} from '../lineDetailsApi'

const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const LINE_ID = '44444444-4444-4444-8444-444444444444'

function line(overrides: Partial<QuoteLineDetails> = {}): QuoteLineDetails {
  return {
    id: LINE_ID,
    name: 'Pump (farm spec)',
    comment: 'Deliver after harvest',
    quantity: '1.0000',
    quantityUnit: 'pc',
    currencyCode: 'EUR',
    unitPriceNet: '1250.0000',
    discountPercent: 0,
    discountAmount: 0,
    taxRate: 23,
    ...overrides,
  }
}

const RATES = [
  { id: 'vat-23', label: 'VAT 23 (23 %)', rate: 23 },
  { id: 'vat-8', label: 'VAT 8 (8 %)', rate: 8 },
]

describe('line details API', () => {
  it('reads a quote line in snake_case or camelCase and finds it by id', () => {
    const parsed = parseQuoteLine(
      {
        items: [
          {
            id: LINE_ID,
            name: 'Pump',
            comment: null,
            quantity: '1.0000',
            quantity_unit: 'pc',
            currency_code: 'EUR',
            unit_price_net: '1250.0000',
            discount_percent: '5.0000',
            discountAmount: 0,
            tax_rate: '23.0000',
          },
        ],
      },
      LINE_ID,
    )
    expect(parsed).toEqual(line({ name: 'Pump', comment: '', discountPercent: 5, taxRate: 23 }))
    expect(parseQuoteLine({ items: [] }, LINE_ID)).toBeNull()
    expect(parseQuoteLine({ nope: true }, LINE_ID)).toBeNull()
  })

  it('labels tax rates with their rate', () => {
    expect(parseTaxRates({ items: [{ id: 'vat-23', name: 'VAT 23', rate: '23.0000' }, { id: 'x', code: 'zero', rate: 0 }] })).toEqual([
      { id: 'vat-23', label: 'VAT 23 (23 %)', rate: 23 },
      { id: 'x', label: 'zero (0 %)', rate: 0 },
    ])
  })

  it('starts from the stored discount mode and the one tax rate with the line rate', () => {
    expect(initialLineForm(line({ discountPercent: 5 }), RATES)).toMatchObject({ discountMode: 'percent', discountValue: '5', taxChoice: 'vat-23' })
    expect(initialLineForm(line({ discountAmount: 100 }), RATES)).toMatchObject({ discountMode: 'amount', discountValue: '100' })
    expect(initialLineForm(line(), RATES)).toMatchObject({ discountMode: 'none', discountValue: '' })
    expect(initialLineForm(line({ taxRate: 5 }), RATES).taxChoice).toBe(TAX_KEEP)
    expect(initialLineForm(line({ taxRate: 23 }), [...RATES, { id: 'vat-23b', label: 'Other 23', rate: 23 }]).taxChoice).toBe(TAX_KEEP)
    expect(initialLineForm(line({ taxRate: 0 }), RATES).taxChoice).toBe(TAX_NONE)
    expect(initialLineForm(line(), null).taxChoice).toBe(TAX_KEEP)
  })

  it('validates name, percentage and amount', () => {
    const base = initialLineForm(line(), RATES)
    expect(validateLineForm(base)).toEqual({})
    expect(validateLineForm({ ...base, name: '  ' })).toEqual({ name: 'required' })
    expect(validateLineForm({ ...base, name: 'x'.repeat(256) })).toEqual({ name: 'too_long' })
    expect(validateLineForm({ ...base, discountMode: 'percent', discountValue: '120' })).toEqual({ discountValue: 'invalid_percent' })
    expect(validateLineForm({ ...base, discountMode: 'percent', discountValue: '0' })).toEqual({ discountValue: 'invalid_percent' })
    expect(validateLineForm({ ...base, discountMode: 'amount', discountValue: 'abc' })).toEqual({ discountValue: 'invalid_amount' })
    expect(validateLineForm({ ...base, discountMode: 'amount', discountValue: '1000,50' })).toEqual({})
    expect(parseDecimalInput('1000,50')).toBe(1000.5)
    expect(parseDecimalInput('-1')).toBeNull()
  })

  it('sends only what changed, with explicit discount modes and a cleared comment as null', () => {
    const initial = initialLineForm(line({ discountPercent: 5 }), RATES)
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, initial)).toBeNull()
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, name: ' Pump (renamed) ' })).toEqual({
      quoteId: QUOTE_ID,
      lineId: LINE_ID,
      name: 'Pump (renamed)',
    })
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, comment: '' })).toEqual({ quoteId: QUOTE_ID, lineId: LINE_ID, comment: null })
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, discountMode: 'amount', discountValue: '1000' })?.discount).toEqual({
      mode: 'amount',
      value: 1000,
    })
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, discountMode: 'none', discountValue: '' })?.discount).toEqual({ mode: 'none' })
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, discountValue: '5.0' })).toBeNull()
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, taxChoice: 'vat-8' })?.taxRateId).toBe('vat-8')
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, initial, { ...initial, taxChoice: TAX_NONE })?.taxRateId).toBeNull()
    expect(buildLineUpdateBody(QUOTE_ID, LINE_ID, { ...initial, taxChoice: 'vat-8' }, { ...initial, taxChoice: TAX_KEEP })).toBeNull()
  })
})
