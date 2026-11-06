import type { CommandBus, CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { lineUpdateSchema, type LineDiscountInput, type LineUpdateInput } from '../data/validators'
import { divideHalfUp, formatScaled, PRICE_SCALE, toScaled } from '../lib/money'
import {
  assertFeatures,
  LINE_UPDATE_FEATURES,
  readConfigurationMarker,
  readQuoteHeader,
  readQuoteLineDetails,
  readStoredLines,
  readTaxRate,
  type QuoteLineDetails,
  type StoredLine,
} from '../lib/quoteAccess'
import { httpError } from './sessions'
import { commandTenantId, quoteNotFound, resolveSessionScope } from './shared'

export const LINE_RESOURCE_KIND = 'product_configurator.line'

export type LineUpdateResult = { lineId: string; quoteId: string; updatedAt: string | null }

const lineNotFound = () => httpError(404, 'line_not_found', 'Quote line not found.')
const notAConfiguredLine = () =>
  httpError(422, 'not_a_configured_line', 'This line was not added by the product configurator.')
const taxRateNotFound = () => httpError(404, 'tax_rate_not_found', 'Tax rate not found.')
const invalidRequest = () => httpError(400, 'invalid_request', 'Invalid request.')

async function parseInput(rawInput: unknown): Promise<LineUpdateInput> {
  const parsed = lineUpdateSchema.safeParse(rawInput)
  if (!parsed.success) throw await invalidRequest()
  return parsed.data
}

/**
 * Explicit discount modes, because a non-zero percentage always wins in sales: an amount clears the
 * percentage, a percentage clears the amount, none clears both. A configured line has quantity 1, so
 * the amount is the discount of the whole line.
 */
export function discountFields(discount: LineDiscountInput): Record<string, unknown> {
  if (discount.mode === 'percent') return { discountPercent: discount.value, discountAmount: 0, discountAmountBasis: 'line' }
  if (discount.mode === 'amount') return { discountAmount: discount.value, discountAmountBasis: 'line', discountPercent: 0 }
  return { discountPercent: 0, discountAmount: 0, discountAmountBasis: 'line' }
}

/**
 * Sales keeps a stored unit gross price while net and gross are both present, so a tax change also
 * sends the gross derived from the unchanged net price and the new rate (half-up at the stored scale).
 */
export function grossFromNet(unitPriceNet: string, taxRate: string): string {
  const net = toScaled(unitPriceNet, PRICE_SCALE)
  const rate = toScaled(taxRate, PRICE_SCALE)
  const hundred = 100n * 10n ** BigInt(PRICE_SCALE)
  return formatScaled(divideHalfUp(net * (hundred + rate), hundred), PRICE_SCALE)
}

/**
 * The sales upsert body: the stored configured inputs unchanged (so the configured line guard passes)
 * plus only the commercial fields the rep changed. Totals are left to sales.
 */
export function buildLineUpsertBody(
  input: LineUpdateInput,
  stored: StoredLine,
  scope: { tenantId: string; organizationId: string },
  taxRate: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: stored.id,
    quoteId: input.quoteId,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    quantity: stored.quantity ?? '1',
  }
  if (stored.productId) body.productId = stored.productId
  if (stored.currencyCode) body.currencyCode = stored.currencyCode
  if (stored.unitPriceNet !== null) body.unitPriceNet = stored.unitPriceNet
  if (input.name !== undefined) body.name = input.name
  if (input.comment !== undefined) body.comment = input.comment ?? ''
  if (input.discount) Object.assign(body, discountFields(input.discount))
  if (taxRate !== null) {
    body.taxRate = taxRate
    if (input.taxRateId) body.taxRateId = input.taxRateId
    if (stored.unitPriceNet !== null) body.unitPriceGross = grossFromNet(stored.unitPriceNet, taxRate)
  }
  return body
}

/**
 * Edits the name, comment, discount and tax rate of a configured quote line through
 * `sales.quotes.lines.upsert`. The request is the caller's own (never marked trusted): it carries the
 * quote lock header, and the configured line guard judges the write like any other.
 */
const updateLineCommand: CommandHandler<LineUpdateInput, LineUpdateResult> = {
  id: 'product_configurator.lines.update',
  isUndoable: false,
  async prepare(rawInput, ctx) {
    const parsed = lineUpdateSchema.safeParse(rawInput)
    if (!parsed.success) return null
    const scope = await resolveSessionScope(ctx)
    const before = await readQuoteLineDetails(ctx.container, parsed.data.lineId, scope)
    return before && before.quoteId === parsed.data.quoteId ? { before } : null
  },
  async execute(rawInput, ctx) {
    const input = await parseInput(rawInput)
    const scope = await resolveSessionScope(ctx)
    await assertFeatures(ctx, LINE_UPDATE_FEATURES, scope)
    if (!(await readQuoteHeader(ctx.container, input.quoteId, scope))) throw await quoteNotFound()
    const stored = (await readStoredLines(ctx.container, 'quote', [input.lineId], scope.tenantId)).get(input.lineId)
    if (!stored || stored.parentId !== input.quoteId) throw await lineNotFound()
    if (!readConfigurationMarker(stored.configuration)) throw await notAConfiguredLine()

    let taxRate: string | null = null
    if (input.taxRateId === null) taxRate = '0'
    if (input.taxRateId) {
      taxRate = await readTaxRate(ctx.container, input.taxRateId, scope)
      if (taxRate === null) throw await taxRateNotFound()
    }

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    await commandBus.execute<{ body: Record<string, unknown> }, { quoteId: string; lineId: string }>('sales.quotes.lines.upsert', {
      input: { body: buildLineUpsertBody(input, stored, scope, taxRate) },
      ctx,
    })
    const quote = await readQuoteHeader(ctx.container, input.quoteId, scope)
    return { lineId: input.lineId, quoteId: input.quoteId, updatedAt: quote?.updatedAt ?? null }
  },
  async captureAfter(_input, result, ctx) {
    const scope = await resolveSessionScope(ctx)
    return readQuoteLineDetails(ctx.container, result.lineId, scope)
  },
  buildLog: async ({ result, ctx, snapshots }) => {
    const { translate } = await resolveTranslations()
    const auditSnapshot = (details: unknown) => {
      const line = details as QuoteLineDetails | null | undefined
      if (!line) return null
      return {
        lineId: result.lineId,
        quoteId: result.quoteId,
        name: line.name,
        comment: line.comment,
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        taxRate: line.taxRate,
      }
    }
    return {
      actionLabel: translate('product_configurator.audit.lines.update', 'Edit configured line details'),
      resourceKind: LINE_RESOURCE_KIND,
      resourceId: result.lineId,
      parentResourceKind: 'sales.quote',
      parentResourceId: result.quoteId,
      tenantId: commandTenantId(ctx),
      organizationId: ctx.selectedOrganizationId ?? null,
      snapshotBefore: auditSnapshot(snapshots.before),
      snapshotAfter: auditSnapshot(snapshots.after),
    }
  },
}

registerCommand(updateLineCommand)

export { updateLineCommand }
