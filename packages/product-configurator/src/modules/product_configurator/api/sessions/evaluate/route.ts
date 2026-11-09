import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { DEFINITION_LIMITS, SESSION_STATUSES, sessionEvaluateSchema, type SessionEvaluateInput } from '../../../data/validators'
import { SESSION_RESOURCE_KIND } from '../../../commands/shared'
import type { SessionEvaluateResult } from '../../../commands/sessions'
import { SESSION_FEATURES } from '../../../lib/quoteAccess'
import { readLimitedJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: [...SESSION_FEATURES] },
}

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const body = await readLimitedJsonObject(req, DEFINITION_LIMITS.evaluateRequestBytes)
    if (body instanceof Response) return body
    const input = sessionEvaluateSchema.parse(body)
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: SESSION_RESOURCE_KIND, resourceId: input.id, operation: 'update', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? sessionEvaluateSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<SessionEvaluateInput, SessionEvaluateResult>('product_configurator.sessions.evaluate', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json(result)
  } catch (error) {
    return routeErrorResponse(error, 'sessions_evaluate')
  }
}

const sessionStateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SESSION_STATUSES),
  revision: z.number().int(),
  selections: z.record(z.string(), z.unknown()),
  evaluation: z.record(z.string(), z.unknown()).nullable(),
})

const evaluationSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Priced evaluation: settled `selections`, `visibility`, `forced`, `calculated`, `availability`, `errors`, `warnings`, `surcharges`, `finalisable`, `bom` (with catalog `label`, `unitPrice`, `total`), `netPrice`, `currencyCode`, `currencyExponent`, `hash`, `summary`, `priceContext`, `evaluatedAt`',
  )

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Evaluate a configuration session',
  methods: {
    POST: {
      summary: 'Evaluate choices and store them on the session',
      description:
        'Evaluates the choices against the session model version, prices the BOM from the catalog for the quote channel and customer (with the customer groups at the evaluation time), stores the choices and the result and returns them with the `revision`, which moves on only when the choices differ from the stored ones (re-evaluating the stored choices keeps it). Send the `revision` last seen; a stale one answers 409 `session_changed` with the current session state. Blocking rule and system errors (`option_not_available`, `no_permitted_values`, `bom_sku_unmapped`, `bom_negative_quantity`) are part of a 200 result with `finalisable: false`. The request body is limited to 64 KB.',
      requestBody: { contentType: 'application/json', schema: sessionEvaluateSchema },
      responses: [{ status: 200, description: 'Stored evaluation', schema: sessionStateSchema.extend({ evaluation: evaluationSchema }) }],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator or sales quote access', schema: errorResponseSchema },
        { status: 404, description: 'Session or quote not found', schema: errorResponseSchema },
        {
          status: 409,
          description: '`session_not_open`, `session_changed` (with `session`) or `currency_mismatch`',
          schema: errorResponseSchema.extend({ session: sessionStateSchema.optional() }),
        },
        { status: 413, description: '`payload_too_large`', schema: errorResponseSchema },
        {
          status: 422,
          description:
            '`invalid_selection` (with `issues`), `forced_value_invalid`, `fixed_point_not_reached`, `expression_error`, `price_missing` (with `params.skus`), or blocked by a mutation guard',
          schema: errorResponseSchema.extend({
            params: z.record(z.string(), z.unknown()).optional(),
            issues: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        },
      ],
    },
  },
}
