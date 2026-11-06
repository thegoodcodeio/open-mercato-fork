import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import type { ModelScope } from '../commands/shared'

const logger = createLogger('product_configurator.api')

export type RouteContext = {
  ctx: CommandRuntimeContext
  scope: ModelScope
  userId: string
}

/**
 * Custom routes act on one organization. "All organizations" (no single selected organization)
 * answers 400 `organization_scope_required`, never 401, so the client does not loop on refresh.
 */
export async function resolveRouteContext(req: Request): Promise<RouteContext | Response> {
  const container = await createRequestContainer()
  const rawAuth = await getAuthFromRequest(req)
  if (!rawAuth?.sub || (rawAuth.tenantId && !z.string().uuid().safeParse(rawAuth.tenantId).success)) {
    const { translate } = await resolveTranslations()
    return NextResponse.json({ error: translate('product_configurator.errors.unauthorized', 'Unauthorized') }, { status: 401 })
  }
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth: rawAuth, request: req })
  const tenantId = organizationScope.tenantId ?? rawAuth.tenantId ?? null
  const organizationId = organizationScope.selectionRejected ? null : (organizationScope.selectedId ?? null)
  if (!tenantId || !organizationId) return organizationScopeRequiredResponse()
  const auth = { ...rawAuth, tenantId, orgId: organizationId }
  return {
    ctx: {
      container,
      auth,
      organizationScope,
      selectedOrganizationId: organizationId,
      organizationIds: organizationScope.filterIds ?? [organizationId],
      request: req,
    },
    scope: { tenantId, organizationId },
    userId: rawAuth.sub,
  }
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const body = await readJsonSafe<unknown>(req, null)
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

async function payloadTooLarge(): Promise<Response> {
  const { translate } = await resolveTranslations()
  return NextResponse.json(
    { error: translate('product_configurator.errors.payload_too_large', 'The request is too large.'), code: 'payload_too_large' },
    { status: 413 },
  )
}

/** The body as UTF-8 text, or null as soon as it grows past `maxBytes`; the rest is never read. */
async function readBodyText(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Reads a JSON object body of at most `maxBytes`. A declared `content-length` above the limit answers
 * 413 `payload_too_large` before the body is read; a body without one (chunked) is streamed and stops
 * at the limit with the same 413. Anything that is not a JSON object reads as `{}`.
 */
export async function readLimitedJsonObject(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return payloadTooLarge()
  const text = await readBodyText(req, maxBytes)
  if (text === null) return payloadTooLarge()
  try {
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function routeErrorResponse(error: unknown, operation: string): Promise<Response> {
  if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
  const interceptorRejection = getCommandInterceptorHttpRejection(error)
  if (interceptorRejection) {
    return NextResponse.json(interceptorRejection.body, { status: interceptorRejection.status })
  }
  const { translate } = await resolveTranslations()
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: translate('product_configurator.errors.invalid_request', 'Invalid request.'), code: 'invalid_request' },
      { status: 400 },
    )
  }
  logger.error(`${operation} failed`, { err: error })
  getTelemetryRuntime()?.reportError(error, { module: 'product_configurator', code: `product_configurator.${operation}_failed` })
  return NextResponse.json(
    { error: translate('product_configurator.errors.unexpected', 'Something went wrong. Try again.') },
    { status: 500 },
  )
}
