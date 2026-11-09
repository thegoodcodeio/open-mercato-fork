import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSnapshot } from '../../data/entities'
import { definitionSchema, SNAPSHOTS_MAX_IDS, snapshotsQuerySchema, type ConfigurationDefinition } from '../../data/validators'
import { quoteNotFound, type ModelScope } from '../../commands/shared'
import {
  assertFeatures,
  findLineCarryingSnapshot,
  readDocumentLines,
  readQuoteHeader,
  readStoredLines,
  SNAPSHOT_QUOTE_FEATURES,
  type StoredLine,
} from '../../lib/quoteAccess'
import { buildSnapshotReadModel, linesBySnapshot, type SnapshotLineFacts, type SnapshotReadModel } from '../../lib/snapshots'
import { resolveRouteContext, routeErrorResponse, type RouteContext } from '../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: [...SNAPSHOT_QUOTE_FEATURES] },
}

const MAX_SNAPSHOTS_PER_QUOTE = 500

type VersionFacts = { version: number; definition: ConfigurationDefinition | null; modelTitle: string | null }

async function snapshotNotFound(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(404, {
    error: translate('product_configurator.errors.snapshot_not_found', 'Configuration not found.'),
    code: 'snapshot_not_found',
  })
}

/** Versions and model titles of the snapshots; a deleted model keeps its title for history. */
async function loadVersionFacts(em: EntityManager, ids: string[], scope: ModelScope): Promise<Map<string, VersionFacts>> {
  const facts = new Map<string, VersionFacts>()
  const uniqueIds = Array.from(new Set(ids))
  if (!uniqueIds.length) return facts
  const where = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const versions = await findWithDecryption(em, ConfigurationModelVersion, { ...where, id: { $in: uniqueIds } }, undefined, scope)
  const modelIds = Array.from(new Set(versions.map((version) => version.modelId)))
  const models = modelIds.length
    ? await findWithDecryption(em, ConfigurationModel, { ...where, id: { $in: modelIds } }, { fields: ['id', 'title'] }, scope)
    : []
  const titles = new Map(models.map((model) => [model.id, model.title]))
  for (const version of versions) {
    const parsed = definitionSchema.safeParse(version.definition)
    facts.set(version.id, {
      version: version.version,
      definition: parsed.success ? parsed.data : null,
      modelTitle: titles.get(version.modelId) ?? null,
    })
  }
  return facts
}

async function toReadModels(
  em: EntityManager,
  snapshots: ConfigurationSnapshot[],
  lineFacts: (snapshot: ConfigurationSnapshot) => SnapshotLineFacts,
  scope: ModelScope,
): Promise<SnapshotReadModel[]> {
  const versions = await loadVersionFacts(em, snapshots.map((snapshot) => snapshot.modelVersionId), scope)
  const { locale } = await resolveTranslations()
  return snapshots.map((snapshot) => {
    const version = versions.get(snapshot.modelVersionId)
    return buildSnapshotReadModel({
      snapshot,
      definition: version?.definition ?? null,
      version: version?.version ?? null,
      modelTitle: version?.modelTitle ?? null,
      line: lineFacts(snapshot),
      locale,
    })
  })
}

/**
 * Configurations of one quote of the selected organization. A snapshot counts when a line of the
 * quote carries it or finalise linked it; a pending snapshot of an unfinished finalise is left out.
 */
async function readQuoteSnapshots(context: RouteContext, em: EntityManager, quoteId: string, ids: string[]): Promise<Response> {
  const { ctx, scope } = context
  const quote = await readQuoteHeader(ctx.container, quoteId, scope)
  if (!quote) throw await quoteNotFound()
  const found = await findWithDecryption(
    em,
    ConfigurationSnapshot,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, quoteId, ...(ids.length ? { id: { $in: ids } } : {}) },
    { orderBy: { createdAt: 'asc', id: 'asc' }, limit: MAX_SNAPSHOTS_PER_QUOTE + 1 },
    scope,
  )
  const truncated = found.length > MAX_SNAPSHOTS_PER_QUOTE
  const snapshots = truncated ? found.slice(0, MAX_SNAPSHOTS_PER_QUOTE) : found
  const carried = linesBySnapshot(await readDocumentLines(ctx.container, 'quote', quoteId, scope))
  const listed = snapshots.filter((snapshot) => snapshot.quoteLineId || carried.has(snapshot.id))
  const items = await toReadModels(
    em,
    listed,
    (snapshot) => {
      const line = carried.get(snapshot.id)
      return line ? { state: 'present', name: line.name } : { state: 'removed', name: null }
    },
    scope,
  )
  return NextResponse.json({ items, truncated })
}

/**
 * The line carrying a snapshot. Linked: the quote line, or the order line with the same id that still
 * carries it. Unlinked (finalise stopped after the sales commit): a line of the quote, or of the order
 * with the quote's id once the quote is gone, that carries it, the same rule as the quote list.
 */
async function findCarrier(context: RouteContext, snapshot: ConfigurationSnapshot): Promise<StoredLine | null> {
  const { ctx, scope } = context
  if (snapshot.quoteLineId) {
    const quoteLine = (await readStoredLines(ctx.container, 'quote', [snapshot.quoteLineId], scope.tenantId)).get(snapshot.quoteLineId)
    if (quoteLine) return quoteLine
    const orderLine = (await readStoredLines(ctx.container, 'order', [snapshot.quoteLineId], scope.tenantId)).get(snapshot.quoteLineId)
    return orderLine && linesBySnapshot([orderLine]).has(snapshot.id) ? orderLine : null
  }
  const onQuote = await findLineCarryingSnapshot(ctx.container, 'quote', snapshot.quoteId, snapshot.id, scope)
  if (onQuote || (await readQuoteHeader(ctx.container, snapshot.quoteId, scope))) return onQuote
  return findLineCarryingSnapshot(ctx.container, 'order', snapshot.quoteId, snapshot.id, scope)
}

/** One snapshot. A pending snapshot (not linked, carried by no line) is not a configuration yet: 404, as the quote list leaves it out. */
async function readSnapshot(context: RouteContext, em: EntityManager, id: string): Promise<Response> {
  const { scope } = context
  const snapshot = await findOneWithDecryption(
    em,
    ConfigurationSnapshot,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (!snapshot) throw await snapshotNotFound()
  const carrier = await findCarrier(context, snapshot)
  if (!snapshot.quoteLineId && !carrier) throw await snapshotNotFound()
  const line: SnapshotLineFacts = carrier ? { state: 'present', name: carrier.name } : { state: 'removed', name: null }
  const [item] = await toReadModels(em, [snapshot], () => line, scope)
  return NextResponse.json(item)
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const query = snapshotsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    await assertFeatures(context.ctx, SNAPSHOT_QUOTE_FEATURES, context.scope)
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    if (query.id) return await readSnapshot(context, em, query.id)
    return await readQuoteSnapshots(context, em, query.quoteId ?? '', query.ids)
  } catch (error) {
    return routeErrorResponse(error, 'snapshots_read')
  }
}

const snapshotRowSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().nullable(),
  decimals: z.number().int().optional().describe('Fraction digits of a labelled formula, when the formula sets them'),
})

const snapshotSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  quoteId: z.string().uuid(),
  quoteLineId: z.string().uuid().nullable(),
  lineState: z.enum(['present', 'removed']),
  lineName: z.string().nullable().describe('Name of the document line carrying the snapshot; null when the line is gone'),
  modelTitle: z.string().nullable(),
  modelVersion: z.object({ id: z.string().uuid(), version: z.number().int().nullable(), hash: z.string() }),
  summary: z.string(),
  selectionRows: z.array(snapshotRowSchema).describe('Visible features in order, with option labels'),
  calculatedRows: z.array(snapshotRowSchema).describe('Labelled formulas'),
  specification: z.array(z.object({ label: z.string(), value: z.string() })),
  bom: z.array(
    z.object({ sku: z.string(), label: z.string(), quantity: z.string(), uom: z.string(), unitPrice: z.string(), total: z.string() }),
  ),
  netPrice: z.string(),
  currencyCode: z.string(),
  warnings: z.array(z.object({ ruleId: z.string(), label: z.string().nullable().describe('Rule label, null when the rule has none'), message: z.string() })),
  hash: z.string(),
  createdAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Product configurations written to quotes',
  methods: {
    GET: {
      summary: 'Read configuration snapshots',
      description: `With \`quoteId\`, lists the configurations of a quote of the selected organization (optionally narrowed by \`ids\`, at most ${SNAPSHOTS_MAX_IDS}); \`lineState\` is \`removed\` when no line of the quote carries the snapshot any more. At most ${MAX_SNAPSHOTS_PER_QUOTE} snapshots are read, oldest first; \`truncated\` is true when the quote has more. With \`id\`, returns one snapshot; its line is \`present\` when the quote line exists or an order line with the same id carries it, and a pending snapshot that no line carries answers 404. Requires \`product_configurator.snapshots.view\` and \`sales.quotes.view\`.`,
      query: z.object({
        id: z.string().uuid().optional(),
        quoteId: z.string().uuid().optional(),
        ids: z.string().optional().describe('Comma-separated snapshot ids, with quoteId'),
      }),
      responses: [
        { status: 200, description: 'One snapshot (by id)', schema: snapshotSchema },
        {
          status: 200,
          description: 'Snapshots of the quote (by quoteId)',
          schema: z.object({
            items: z.array(snapshotSchema),
            truncated: z.boolean().describe(`True when the quote has more than ${MAX_SNAPSHOTS_PER_QUOTE} snapshots and only the oldest are listed`),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid query or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configuration or sales quote access', schema: errorResponseSchema },
        { status: 404, description: 'Snapshot or quote not found in the selected organization', schema: errorResponseSchema },
      ],
    },
  },
}
