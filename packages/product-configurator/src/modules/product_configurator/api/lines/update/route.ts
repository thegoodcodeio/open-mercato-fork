import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { lineUpdateSchema, type LineUpdateInput } from '../../../data/validators'
import type { LineUpdateResult } from '../../../commands/lines'
import { LINE_UPDATE_FEATURES } from '../../../lib/quoteAccess'
import { readJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: [...LINE_UPDATE_FEATURES] },
}

/** The write changes the quote, so mutation guards (record locks) are asked about the quote. */
const QUOTE_RESOURCE_KIND = 'sales.quote'

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const input = lineUpdateSchema.parse(await readJsonObject(req))
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: QUOTE_RESOURCE_KIND, resourceId: input.quoteId, operation: 'update', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? lineUpdateSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<LineUpdateInput, LineUpdateResult>('product_configurator.lines.update', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json({ lineId: result.lineId, updatedAt: result.updatedAt })
  } catch (error) {
    return routeErrorResponse(error, 'lines_update')
  }
}

const discountSchema = z
  .object({
    mode: z.enum(['none', 'percent', 'amount']),
    value: z.number().optional().describe('Percent (0 < value <= 100) or amount in the quote currency for the whole line; not sent with `none`'),
  })
  .describe('`percent` clears the amount, `amount` clears the percentage, `none` clears both')

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Edit a configured quote line',
  methods: {
    POST: {
      summary: 'Edit the name, comment, discount and tax rate of a configured quote line',
      description: `Writes the line through \`sales.quotes.lines.upsert\` with its configured inputs (product, currency, quantity, net unit price) unchanged; sales recomputes gross, tax and totals. Send the quote \`updatedAt\` in the \`${OPTIMISTIC_LOCK_HEADER_NAME}\` header. \`taxRateId: null\` removes the tax rate. Answers the quote's new \`updatedAt\`. Needs \`sales.quotes.manage\`.`,
      requestBody: {
        contentType: 'application/json',
        schema: z.object({
          quoteId: z.string().uuid(),
          lineId: z.string().uuid(),
          name: z.string().optional(),
          comment: z.string().nullable().optional().describe('Empty or null clears the comment'),
          discount: discountSchema.optional(),
          taxRateId: z.string().uuid().nullable().optional(),
        }),
      },
      responses: [
        {
          status: 200,
          description: 'Line updated',
          schema: z.object({ lineId: z.string().uuid(), updatedAt: z.string().nullable().describe('The quote updatedAt after the write (next lock token)') }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid request (nothing to update) or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator or quote edit access', schema: errorResponseSchema },
        { status: 404, description: '`quote_not_found`, `line_not_found` or `tax_rate_not_found`', schema: errorResponseSchema },
        { status: 409, description: 'The quote changed since `updatedAt` (optimistic lock)', schema: errorResponseSchema },
        { status: 422, description: '`not_a_configured_line`, or blocked by a mutation guard', schema: errorResponseSchema },
      ],
    },
  },
}
