import { z } from 'zod'

export const LINES_UPDATE_API = '/api/product_configurator/lines/update'
export const QUOTE_RESOURCE_KIND = 'sales.quote'
export const NAME_MAX_LENGTH = 255
export const COMMENT_MAX_LENGTH = 2000

/** Tax select value that keeps the line's current tax: sales stores only the rate on a line, not the tax rate id. */
export const TAX_KEEP = '__keep__'
/** Tax select value for "no tax rate" (0 %). */
export const TAX_NONE = '__none__'

export function quoteLineUrl(quoteId: string, lineId: string): string {
  return `/api/sales/quote-lines?quoteId=${encodeURIComponent(quoteId)}&id=${encodeURIComponent(lineId)}&pageSize=1`
}

export const TAX_RATES_URL = '/api/sales/tax-rates?pageSize=100'
/** The feature `GET /api/sales/tax-rates` requires. */
export const TAX_RATES_FEATURE = 'sales.settings.manage'

const decimalValue = z.union([z.string(), z.number()]).nullable().optional()

/** Sales returns line fields in snake_case on the list route; the camelCase spelling is accepted too. */
const quoteLineItemSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
    quantity: decimalValue,
    quantity_unit: z.string().nullable().optional(),
    quantityUnit: z.string().nullable().optional(),
    currency_code: z.string().nullable().optional(),
    currencyCode: z.string().nullable().optional(),
    unit_price_net: decimalValue,
    unitPriceNet: decimalValue,
    discount_percent: decimalValue,
    discountPercent: decimalValue,
    discount_amount: decimalValue,
    discountAmount: decimalValue,
    tax_rate: decimalValue,
    taxRate: decimalValue,
  })
  .passthrough()

export type QuoteLineDetails = {
  id: string
  name: string
  comment: string
  quantity: string
  quantityUnit: string | null
  currencyCode: string | null
  unitPriceNet: string
  discountPercent: number
  discountAmount: number
  taxRate: number
}

function decimalText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '0'
  return String(value)
}

function decimalNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The line from `GET /api/sales/quote-lines?id=`, or null when the quote has no such line. */
export function parseQuoteLine(payload: unknown, lineId: string): QuoteLineDetails | null {
  const parsed = z.object({ items: z.array(quoteLineItemSchema) }).safeParse(payload)
  if (!parsed.success) return null
  const item = parsed.data.items.find((entry) => entry.id === lineId)
  if (!item) return null
  return {
    id: item.id,
    name: item.name ?? '',
    comment: item.comment ?? '',
    quantity: decimalText(item.quantity),
    quantityUnit: item.quantity_unit ?? item.quantityUnit ?? null,
    currencyCode: item.currency_code ?? item.currencyCode ?? null,
    unitPriceNet: decimalText(item.unit_price_net ?? item.unitPriceNet),
    discountPercent: decimalNumber(item.discount_percent ?? item.discountPercent),
    discountAmount: decimalNumber(item.discount_amount ?? item.discountAmount),
    taxRate: decimalNumber(item.tax_rate ?? item.taxRate),
  }
}

const taxRateItemSchema = z
  .object({ id: z.string(), name: z.string().nullable().optional(), code: z.string().nullable().optional(), rate: decimalValue })
  .passthrough()

export type TaxRateOption = { id: string; label: string; rate: number }

export function parseTaxRates(payload: unknown): TaxRateOption[] | null {
  const parsed = z.object({ items: z.array(taxRateItemSchema) }).safeParse(payload)
  if (!parsed.success) return null
  return parsed.data.items.map((item) => {
    const rate = decimalNumber(item.rate)
    const name = item.name?.trim() || item.code?.trim() || item.id
    return { id: item.id, label: `${name} (${rate} %)`, rate }
  })
}

export type DiscountMode = 'none' | 'percent' | 'amount'

export type LineDetailsForm = {
  name: string
  comment: string
  discountMode: DiscountMode
  /** Text as typed; a comma is accepted as the decimal separator. */
  discountValue: string
  /** A tax rate id, `TAX_KEEP` or `TAX_NONE`. */
  taxChoice: string
}

/**
 * The form for a line. A non-zero percentage wins in sales, so it decides the mode first. The tax rate is
 * preselected when exactly one rate of the list has the line's rate; otherwise the current tax is kept.
 */
export function initialLineForm(line: QuoteLineDetails, taxRates: TaxRateOption[] | null): LineDetailsForm {
  const discountMode: DiscountMode = line.discountPercent > 0 ? 'percent' : line.discountAmount > 0 ? 'amount' : 'none'
  const discountValue = discountMode === 'percent' ? String(line.discountPercent) : discountMode === 'amount' ? String(line.discountAmount) : ''
  const matching = (taxRates ?? []).filter((rate) => rate.rate === line.taxRate)
  const taxChoice = matching.length === 1 ? matching[0].id : line.taxRate === 0 && matching.length === 0 ? TAX_NONE : TAX_KEEP
  return { name: line.name, comment: line.comment, discountMode, discountValue, taxChoice }
}

export function parseDecimalInput(text: string): number | null {
  const normalized = text.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

export type LineFormErrors = Partial<Record<'name' | 'comment' | 'discountValue', 'required' | 'too_long' | 'invalid_percent' | 'invalid_amount'>>

export function validateLineForm(form: LineDetailsForm): LineFormErrors {
  const errors: LineFormErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = 'required'
  else if (name.length > NAME_MAX_LENGTH) errors.name = 'too_long'
  if (form.comment.trim().length > COMMENT_MAX_LENGTH) errors.comment = 'too_long'
  if (form.discountMode !== 'none') {
    const value = parseDecimalInput(form.discountValue)
    if (form.discountMode === 'percent' && (value === null || value <= 0 || value > 100)) errors.discountValue = 'invalid_percent'
    if (form.discountMode === 'amount' && (value === null || value <= 0)) errors.discountValue = 'invalid_amount'
  }
  return errors
}

export type LineUpdateBody = {
  quoteId: string
  lineId: string
  name?: string
  comment?: string | null
  discount?: { mode: 'none' } | { mode: 'percent' | 'amount'; value: number }
  taxRateId?: string | null
}

function discountOf(form: LineDetailsForm): NonNullable<LineUpdateBody['discount']> | null {
  if (form.discountMode === 'none') return { mode: 'none' }
  const value = parseDecimalInput(form.discountValue)
  return value === null ? null : { mode: form.discountMode, value }
}

function sameDiscount(left: LineUpdateBody['discount'] | null, right: LineUpdateBody['discount'] | null): boolean {
  if (!left || !right) return left === right
  if (left.mode !== right.mode) return false
  return left.mode === 'none' || ('value' in right && left.value === right.value)
}

/** `POST /lines/update` body with only the fields the rep changed, or null when nothing changed. */
export function buildLineUpdateBody(quoteId: string, lineId: string, initial: LineDetailsForm, form: LineDetailsForm): LineUpdateBody | null {
  const body: LineUpdateBody = { quoteId, lineId }
  const name = form.name.trim()
  if (name !== initial.name.trim()) body.name = name
  const comment = form.comment.trim()
  if (comment !== initial.comment.trim()) body.comment = comment ? comment : null
  const discount = discountOf(form)
  if (discount && !sameDiscount(discount, discountOf(initial))) body.discount = discount
  if (form.taxChoice !== initial.taxChoice && form.taxChoice !== TAX_KEEP) body.taxRateId = form.taxChoice === TAX_NONE ? null : form.taxChoice
  return Object.keys(body).length > 2 ? body : null
}

export const lineUpdateResponseSchema = z.object({ lineId: z.string(), updatedAt: z.string().nullable() })
