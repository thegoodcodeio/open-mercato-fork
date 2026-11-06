import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { SESSION_STATUSES, sessionFinaliseSchema, type SessionFinaliseInput } from '../../../data/validators'
import { SESSION_RESOURCE_KIND } from '../../../commands/shared'
import type { FinaliseResult } from '../../../lib/finalise'
import { FINALISE_FEATURES } from '../../../lib/quoteAccess'
import { readJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: [...FINALISE_FEATURES] },
}

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const input = sessionFinaliseSchema.parse(await readJsonObject(req))
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: SESSION_RESOURCE_KIND, resourceId: input.id, operation: 'update', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? sessionFinaliseSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<SessionFinaliseInput, FinaliseResult>('product_configurator.sessions.finalise', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json(result)
  } catch (error) {
    return routeErrorResponse(error, 'sessions_finalise')
  }
}

const sessionStateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SESSION_STATUSES),
  revision: z.number().int(),
  selections: z.record(z.string(), z.unknown()),
  evaluation: z.record(z.string(), z.unknown()).nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Add a configuration to its quote',
  methods: {
    POST: {
      summary: 'Finalise a configuration session into a quote line',
      description:
        'Serialized per quote. First adopts a line already committed for this session (on the quote, or on the order after a conversion) without re-evaluating. Otherwise re-reads the quote, checks the `revision`, re-evaluates on current catalog prices, refuses unless the result is finalisable and its hash equals `expectedHash`, writes the snapshot and then the quote line through `sales.quotes.lines.upsert` with the quote `updatedAt` read before as the optimistic lock. A finalised session returns its stored result with `replay: true`. `outcome` is `added_with_earlier_choices` when the line added (adopted from an earlier attempt, or a replay) carries another result than `expectedHash`: the session is finalised and later changes were not added. Needs `sales.quotes.manage`.',
      requestBody: { contentType: 'application/json', schema: sessionFinaliseSchema },
      responses: [
        {
          status: 200,
          description: 'The configured line',
          schema: z.object({
            snapshotId: z.string().uuid(),
            quoteLineId: z.string().uuid(),
            hash: z.string().describe('Hash of the added snapshot'),
            replay: z.boolean(),
            outcome: z
              .enum(['added', 'added_with_earlier_choices'])
              .describe('`added_with_earlier_choices`: the line added carries an earlier result than `expectedHash`; the session is finalised'),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator access or quote edit rights', schema: errorResponseSchema },
        { status: 404, description: 'Session not found', schema: errorResponseSchema },
        {
          status: 409,
          description:
            '`result_changed` (with the new `result`), `session_changed` (with `session`), `session_not_open` (with `status`), `finalise_in_progress` (another finalise holds this quote), `finalise_busy` (no free quote lock connection in this process within 2 s; retry), `quote_changed`, `quote_converted` (session cancelled), `currency_mismatch`, `model_deleted`',
          schema: errorResponseSchema.extend({
            result: z.record(z.string(), z.unknown()).optional(),
            session: sessionStateSchema.optional(),
            status: z.enum(SESSION_STATUSES).optional(),
          }),
        },
        {
          status: 422,
          description:
            '`migration_unconfirmed`, `not_finalisable` (with `result`), `product_missing`, `price_missing`, `expression_error`, `fixed_point_not_reached`, `invalid_selection`, `forced_value_invalid`, or blocked by a mutation guard',
          schema: errorResponseSchema.extend({ params: z.record(z.string(), z.unknown()).optional() }),
        },
        {
          status: 502,
          description:
            '`quote_line_write_failed`. `status: open`: nothing was committed and the session is open again. `status: finalising`: whether the line was committed is unknown (the lines could not be read); the session stays `finalising` and the next finalise call with the same body reconciles it',
          schema: errorResponseSchema.extend({ status: z.enum(['open', 'finalising']) }),
        },
      ],
    },
  },
}
