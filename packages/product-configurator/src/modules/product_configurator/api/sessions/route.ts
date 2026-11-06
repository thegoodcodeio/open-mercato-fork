import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSession, ConfigurationSnapshot } from '../../data/entities'
import {
  SESSION_IN_PROGRESS_STATUSES,
  SESSION_STATUSES,
  sessionOpenSchema,
  sessionsQuerySchema,
  type SessionOpenInput,
} from '../../data/validators'
import { findSession, sessionNotFound, SESSION_RESOURCE_KIND, type ModelScope } from '../../commands/shared'
import type { SessionOpenResult } from '../../commands/sessions'
import { assertFeatures, readQuoteHeader, readStoredLines, readUserDisplayNames, SESSION_FEATURES } from '../../lib/quoteAccess'
import { readJsonObject, resolveRouteContext, routeErrorResponse, type RouteContext } from '../helpers'
import { errorResponseSchema, opaqueDefinitionSchema, productConfiguratorTag } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: [...SESSION_FEATURES] },
  POST: { requireAuth: true, requireFeatures: [...SESSION_FEATURES] },
}

const MAX_SESSIONS_PER_QUOTE = 100

type VersionInfo = { version: ConfigurationModelVersion; model: ConfigurationModel | null }

async function loadVersions(em: EntityManager, ids: string[], scope: ModelScope): Promise<Map<string, VersionInfo>> {
  const result = new Map<string, VersionInfo>()
  const uniqueIds = Array.from(new Set(ids))
  if (!uniqueIds.length) return result
  const where = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const versions = await findWithDecryption(em, ConfigurationModelVersion, { ...where, id: { $in: uniqueIds } }, undefined, scope)
  const modelIds = Array.from(new Set(versions.map((version) => version.modelId)))
  const models = modelIds.length
    ? await findWithDecryption(em, ConfigurationModel, { ...where, id: { $in: modelIds } }, { fields: ['id', 'title'] }, scope)
    : []
  const modelsById = new Map(models.map((model) => [model.id, model]))
  for (const version of versions) result.set(version.id, { version, model: modelsById.get(version.modelId) ?? null })
  return result
}

function versionRef(info: VersionInfo | undefined, id: string) {
  return {
    id,
    version: info?.version.version ?? null,
    hash: info?.version.hash ?? null,
    modelId: info?.version.modelId ?? null,
    modelTitle: info?.model?.title ?? null,
  }
}

function createdByRef(session: ConfigurationSession, names: Map<string, string | null>) {
  return session.createdBy ? { id: session.createdBy, displayName: names.get(session.createdBy) ?? null } : null
}

/** Name of the quote line that carries a copy's source snapshot; null when the line is gone. */
async function readSourceLineName(context: RouteContext, em: EntityManager, sourceSnapshotId: string | null | undefined): Promise<string | null> {
  if (!sourceSnapshotId) return null
  const { scope, ctx } = context
  const snapshot = await findOneWithDecryption(
    em,
    ConfigurationSnapshot,
    { id: sourceSnapshotId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { fields: ['id', 'quoteLineId'] },
    scope,
  )
  if (!snapshot?.quoteLineId) return null
  const lines = await readStoredLines(ctx.container, 'quote', [snapshot.quoteLineId], scope.tenantId)
  return lines.get(snapshot.quoteLineId)?.name ?? null
}

async function readSessionDetail(context: RouteContext, em: EntityManager, id: string): Promise<Response> {
  const { scope, ctx } = context
  const session = await findSession(em, id, scope)
  if (!session) throw await sessionNotFound()
  const versions = await loadVersions(em, [session.modelVersionId], scope)
  const info = versions.get(session.modelVersionId)
  const quote = await readQuoteHeader(ctx.container, session.quoteId, scope)
  const names = await readUserDisplayNames(ctx.container, session.createdBy ? [session.createdBy] : [], scope.tenantId)
  const sourceLineName = await readSourceLineName(context, em, session.sourceSnapshotId)
  return NextResponse.json({
    id: session.id,
    status: session.status,
    mode: session.mode,
    revision: session.revision,
    quoteId: session.quoteId,
    sourceSnapshotId: session.sourceSnapshotId ?? null,
    sourceLineName,
    quote: quote ? { id: quote.id, number: quote.quoteNumber, customerName: quote.customerName, currencyCode: quote.currencyCode } : null,
    modelVersion: { ...versionRef(info, session.modelVersionId), definition: info?.version.definition ?? null },
    selections: session.selections,
    evaluation: session.evaluation ?? null,
    migration: session.migration ?? null,
    createdBy: createdByRef(session, names),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  })
}

async function readQuoteSessions(
  context: RouteContext,
  em: EntityManager,
  quoteId: string,
  statuses: Array<(typeof SESSION_STATUSES)[number]>,
): Promise<Response> {
  const { scope, ctx } = context
  const sessions = await findWithDecryption(
    em,
    ConfigurationSession,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      quoteId,
      status: { $in: statuses.length ? statuses : [...SESSION_IN_PROGRESS_STATUSES] },
    },
    { orderBy: { createdAt: 'desc', id: 'desc' }, limit: MAX_SESSIONS_PER_QUOTE },
    scope,
  )
  const versions = await loadVersions(em, sessions.map((session) => session.modelVersionId), scope)
  const creators = sessions.map((session) => session.createdBy).filter((id): id is string => Boolean(id))
  const names = await readUserDisplayNames(ctx.container, creators, scope.tenantId)
  return NextResponse.json({
    items: sessions.map((session) => ({
      id: session.id,
      status: session.status,
      mode: session.mode,
      revision: session.revision,
      quoteId: session.quoteId,
      sourceSnapshotId: session.sourceSnapshotId ?? null,
      modelVersion: versionRef(versions.get(session.modelVersionId), session.modelVersionId),
      createdBy: createdByRef(session, names),
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    })),
  })
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const query = sessionsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    await assertFeatures(context.ctx, SESSION_FEATURES, context.scope)
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    if (query.id) return await readSessionDetail(context, em, query.id)
    return await readQuoteSessions(context, em, query.quoteId ?? '', query.status)
  } catch (error) {
    return routeErrorResponse(error, 'sessions_read')
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const input = sessionOpenSchema.parse(await readJsonObject(req))
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: SESSION_RESOURCE_KIND, resourceId: null, operation: 'create', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? sessionOpenSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<SessionOpenInput, SessionOpenResult>('product_configurator.sessions.open', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    return routeErrorResponse(error, 'sessions_open')
  }
}

const modelVersionRefSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nullable(),
  hash: z.string().nullable(),
  modelId: z.string().uuid().nullable(),
  modelTitle: z.string().nullable(),
})

const migrationItemSchema = z.object({
  featureKey: z.string(),
  label: z.string(),
  oldValue: z.union([z.string(), z.number(), z.boolean()]),
  oldDisplay: z.union([z.string(), z.number(), z.boolean()]).describe('Option label in the old version for choices and colors'),
  reason: z.enum(['kept', 'feature_removed', 'option_removed', 'out_of_range', 'type_changed']),
})

const migrationSchema = z
  .object({
    fromVersion: z.object({ id: z.string().uuid(), version: z.number().int() }),
    toVersion: z.object({ id: z.string().uuid(), version: z.number().int() }),
    kept: z.array(migrationItemSchema),
    dropped: z.array(migrationItemSchema).describe('Features removed in the new version'),
    reset: z.array(migrationItemSchema).describe('Values the new version refuses; the field takes its default or a force rule'),
  })
  .nullable()
  .describe('Copied choices the latest version dropped or reset; null when nothing moved. Finalise then needs `migrationAcknowledged: true`')

const createdBySchema = z.object({ id: z.string().uuid(), displayName: z.string().nullable() }).nullable()

const sessionDetailSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SESSION_STATUSES),
  mode: z.enum(['new', 'duplicate']),
  revision: z.number().int(),
  quoteId: z.string().uuid(),
  sourceSnapshotId: z.string().uuid().nullable().describe('The snapshot a copy was opened from'),
  sourceLineName: z.string().nullable().describe('Name of the quote line carrying the source snapshot; null when the line is gone'),
  quote: z
    .object({ id: z.string().uuid(), number: z.string().nullable(), customerName: z.string().nullable(), currencyCode: z.string() })
    .nullable()
    .describe('Null when the quote no longer exists (converted or deleted)'),
  modelVersion: modelVersionRefSchema.extend({ definition: opaqueDefinitionSchema.nullable() }),
  selections: z.record(z.string(), z.unknown()).describe('User intent only; values set by force rules are in the evaluation'),
  evaluation: z.record(z.string(), z.unknown()).nullable().describe('Last stored priced evaluation, null before the first evaluate'),
  migration: migrationSchema,
  createdBy: createdBySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

const sessionListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      status: z.enum(SESSION_STATUSES),
      mode: z.enum(['new', 'duplicate']),
      revision: z.number().int(),
      quoteId: z.string().uuid(),
      sourceSnapshotId: z.string().uuid().nullable(),
      modelVersion: modelVersionRefSchema,
      createdBy: createdBySchema,
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
})

const openResponseSchema = z.object({
  sessionId: z.string().uuid(),
  revision: z.number().int(),
  mode: z.enum(['new', 'duplicate']),
  sourceSnapshotId: z.string().uuid().nullable(),
  modelVersion: z.object({
    id: z.string().uuid(),
    version: z.number().int(),
    hash: z.string(),
    modelId: z.string().uuid(),
    modelTitle: z.string(),
  }),
  quote: z.object({ id: z.string().uuid(), number: z.string().nullable(), customerName: z.string().nullable() }),
  migration: migrationSchema,
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Configuration sessions',
  methods: {
    GET: {
      summary: 'Read a configuration session or the sessions of a quote',
      description:
        'With `id`, returns one session of the selected organization with its model version (including the definition), the last stored evaluation and the quote header read at request time. With `quoteId`, lists the sessions of the quote, by default the ones in progress (`open`, `finalising`); `status` takes a comma-separated list. Requires sales visibility of quotes (`sales.quotes.view`).',
      query: z.object({
        id: z.string().uuid().optional(),
        quoteId: z.string().uuid().optional(),
        status: z.string().optional().describe('Comma-separated statuses for the quote list'),
      }),
      responses: [
        { status: 200, description: 'Session detail (by id)', schema: sessionDetailSchema },
        { status: 200, description: 'Sessions of the quote (by quoteId)', schema: sessionListSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid query or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator or sales quote access', schema: errorResponseSchema },
        { status: 404, description: 'Session not found', schema: errorResponseSchema },
      ],
    },
    POST: {
      summary: 'Open a configuration session on a quote',
      description:
        'Opens a session on the latest published version of a model whose currency matches the quote. Without `modelId`, the only fitting model is used; several fitting models answer 409 `model_required` with `candidateIds`. With `fromSnapshotId` (mode `duplicate`, the default with a snapshot) the session copies a snapshot of this quote: it opens on the latest version of the snapshot\'s model with the copied choices mapped onto it, and `migration` lists the choices that version dropped or reset (finalise then needs `migrationAcknowledged`). Finalising a copy adds a separate line. `mode` supports `new` and `duplicate`; any other mode, `duplicate` without a snapshot or `new` with one answers 400 `mode_not_supported`.',
      requestBody: { contentType: 'application/json', schema: sessionOpenSchema },
      responses: [{ status: 201, description: 'Session opened', schema: openResponseSchema }],
      errors: [
        { status: 400, description: '`mode_not_supported`, invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configurator or sales quote access', schema: errorResponseSchema },
        { status: 404, description: 'Quote or model not found', schema: errorResponseSchema },
        {
          status: 409,
          description: '`currency_mismatch`, `no_published_version` or `model_required` (with `candidateIds`)',
          schema: errorResponseSchema.extend({ candidateIds: z.array(z.string().uuid()).optional() }),
        },
        {
          status: 422,
          description: '`snapshot_not_in_quote` (the snapshot is not in this quote of the selected organization, or `modelId` names another model), or blocked by a mutation guard',
          schema: errorResponseSchema,
        },
      ],
    },
  },
}
