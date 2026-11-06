import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { SESSION_STATUSES, sessionIdSchema, type SessionIdInput } from '../../../data/validators'
import { SESSION_RESOURCE_KIND } from '../../../commands/shared'
import type { SessionCancelResult } from '../../../commands/sessions'
import { SESSION_FEATURES } from '../../../lib/quoteAccess'
import { readJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: [...SESSION_FEATURES] },
}

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const input = sessionIdSchema.parse(await readJsonObject(req))
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: SESSION_RESOURCE_KIND, resourceId: input.id, operation: 'custom', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? sessionIdSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<SessionIdInput, SessionCancelResult>('product_configurator.sessions.cancel', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json({ status: result.status })
  } catch (error) {
    return routeErrorResponse(error, 'sessions_cancel')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Discard a configuration session',
  methods: {
    POST: {
      summary: 'Cancel an open configuration session',
      description: 'Ends an `open` session as `cancelled`. Nothing is written to the quote. Sessions in any other status answer 409 `session_not_open`.',
      requestBody: { contentType: 'application/json', schema: sessionIdSchema },
      responses: [{ status: 200, description: 'Session cancelled', schema: z.object({ status: z.enum(SESSION_STATUSES) }) }],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator or sales quote access', schema: errorResponseSchema },
        { status: 404, description: 'Session not found', schema: errorResponseSchema },
        { status: 409, description: '`session_not_open`', schema: errorResponseSchema.extend({ status: z.enum(SESSION_STATUSES).optional() }) },
        { status: 422, description: 'Blocked by a mutation guard', schema: errorResponseSchema },
      ],
    },
  },
}
