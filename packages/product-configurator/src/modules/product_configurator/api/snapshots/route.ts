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
  orderExists,
  readDocumentLines,
  readDocumentLinesByIds,
  readQuoteHeader,
  readStoredLines,
  SNAPSHOT_ORDER_FEATURES,
  SNAPSHOT_QUOTE_FEATURES,
  type DocumentKind,
  type StoredLine,
} from '../../lib/quoteAccess'
import {
  buildSnapshotReadModel,
  linesBySnapshot,
  presentLine,
  REMOVED_LINE,
  type SnapshotLineFacts,
  type SnapshotReadModel,
} from '../../lib/snapshots'
import { resolveRouteContext, routeErrorResponse, type RouteContext } from '../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../openapi'

/** The handler adds the sales feature of the document asked for: quote visibility, or order visibility with `orderId`. */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['product_configurator.snapshots.view'] },
}

const MAX_SNAPSHOTS_PER_QUOTE = 500
const ID_CHUNK_SIZE = 100

type VersionFacts = { version: number; definition: ConfigurationDefinition | null; modelTitle: string | null }

async function orderNotFound(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(404, {
    error: translate('product_configurator.errors.order_not_found', 'Order not found.'),
    code: 'order_not_found',
  })
}

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
 * The lines of one quote or order carrying the given snapshots, by snapshot id, without reading every
 * line of the document: a linked snapshot can only be carried by the line with its `quote_line_id`
 * (order lines keep the quote line ids). Only an unlinked snapshot needs all lines.
 */
async function readCarriers(
  context: RouteContext,
  kind: DocumentKind,
  parentId: string,
  snapshots: ConfigurationSnapshot[],
): Promise<Map<string, StoredLine>> {
  const { ctx, scope } = context
  const linkedLineIds = snapshots.flatMap((snapshot) => (snapshot.quoteLineId ? [snapshot.quoteLineId] : []))
  const carried = linesBySnapshot(await readDocumentLinesByIds(ctx.container, kind, parentId, linkedLineIds, scope))
  if (snapshots.every((snapshot) => snapshot.quoteLineId)) return carried
  const allCarried = linesBySnapshot(await readDocumentLines(ctx.container, kind, parentId, scope))
  for (const snapshot of snapshots) {
    const line = allCarried.get(snapshot.id)
    if (!snapshot.quoteLineId && line) carried.set(snapshot.id, line)
  }
  return carried
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
  const carried = await readCarriers(context, 'quote', quoteId, snapshots)
  const listed = snapshots.filter((snapshot) => snapshot.quoteLineId || carried.has(snapshot.id))
  const items = await toReadModels(
    em,
    listed,
    (snapshot) => {
      const line = carried.get(snapshot.id)
      return line ? presentLine(line) : REMOVED_LINE
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
  const line = carrier ? presentLine(carrier) : REMOVED_LINE
  const [item] = await toReadModels(em, [snapshot], () => line, scope)
  return NextResponse.json(item)
}

async function assertOrderExists(context: RouteContext, orderId: string): Promise<void> {
  if (!(await orderExists(context.ctx.container, orderId, context.scope))) throw await orderNotFound()
}

async function findSnapshots(em: EntityManager, ids: string[], scope: ModelScope): Promise<ConfigurationSnapshot[]> {
  const found: ConfigurationSnapshot[] = []
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + ID_CHUNK_SIZE)
    found.push(
      ...(await findWithDecryption(
        em,
        ConfigurationSnapshot,
        { tenantId: scope.tenantId, organizationId: scope.organizationId, id: { $in: chunk } },
        undefined,
        scope,
      )),
    )
  }
  return found.sort(byCreatedAt)
}

function byCreatedAt(left: Pick<ConfigurationSnapshot, 'id' | 'createdAt'>, right: Pick<ConfigurationSnapshot, 'id' | 'createdAt'>): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
}

/** Ids of the oldest `limit` stored snapshots among `ids`, read by id and creation time only. */
async function findOldestSnapshotIds(em: EntityManager, ids: string[], scope: ModelScope, limit: number): Promise<string[]> {
  const found: Array<Pick<ConfigurationSnapshot, 'id' | 'createdAt'>> = []
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + ID_CHUNK_SIZE)
    found.push(
      ...(await findWithDecryption(
        em,
        ConfigurationSnapshot,
        { tenantId: scope.tenantId, organizationId: scope.organizationId, id: { $in: chunk } },
        { fields: ['id', 'createdAt'] },
        scope,
      )),
    )
  }
  return found.sort(byCreatedAt).slice(0, limit).map((snapshot) => snapshot.id)
}

/**
 * Configurations on one order: the snapshots its lines reference (quote and quote line ids are history
 * after a conversion), oldest first, at most as many as a quote lists. Only the listed snapshots are
 * loaded in full; narrowed by `ids`, only the lines that can carry them are read.
 */
async function readOrderSnapshots(context: RouteContext, em: EntityManager, orderId: string, ids: string[]): Promise<Response> {
  const { ctx, scope } = context
  await assertOrderExists(context, orderId)
  let snapshots: ConfigurationSnapshot[]
  let carried: Map<string, StoredLine>
  let truncated = false
  if (ids.length) {
    const requested = await findSnapshots(em, ids, scope)
    carried = await readCarriers(context, 'order', orderId, requested)
    snapshots = requested.filter((snapshot) => carried.has(snapshot.id))
  } else {
    carried = linesBySnapshot(await readDocumentLines(ctx.container, 'order', orderId, scope))
    const oldest = await findOldestSnapshotIds(em, Array.from(carried.keys()), scope, MAX_SNAPSHOTS_PER_QUOTE + 1)
    truncated = oldest.length > MAX_SNAPSHOTS_PER_QUOTE
    snapshots = await findSnapshots(em, oldest.slice(0, MAX_SNAPSHOTS_PER_QUOTE), scope)
  }
  const items = await toReadModels(em, snapshots, (snapshot) => {
    const line = carried.get(snapshot.id)
    return line ? presentLine(line) : REMOVED_LINE
  }, scope)
  return NextResponse.json({ items, truncated })
}

/** One snapshot opened from an order: a line of that order must carry it. */
async function readOrderSnapshot(context: RouteContext, em: EntityManager, orderId: string, id: string): Promise<Response> {
  await assertOrderExists(context, orderId)
  const [snapshot] = await findSnapshots(em, [id], context.scope)
  if (!snapshot) throw await snapshotNotFound()
  const carrier = (await readCarriers(context, 'order', orderId, [snapshot])).get(id)
  if (!carrier) throw await snapshotNotFound()
  const [item] = await toReadModels(em, [snapshot], () => presentLine(carrier), context.scope)
  return NextResponse.json(item)
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const query = snapshotsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    await assertFeatures(context.ctx, query.orderId ? SNAPSHOT_ORDER_FEATURES : SNAPSHOT_QUOTE_FEATURES, context.scope)
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    if (query.orderId) {
      return query.id
        ? await readOrderSnapshot(context, em, query.orderId, query.id)
        : await readOrderSnapshots(context, em, query.orderId, query.ids)
    }
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
  lineId: z.string().uuid().nullable().describe('The line carrying the snapshot in the document asked for; null when removed'),
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
      description: `With \`orderId\`, lists the configurations the lines of an order of the selected organization carry (optionally narrowed by \`ids\`), oldest first, at most ${MAX_SNAPSHOTS_PER_QUOTE}; with \`id\` and \`orderId\`, returns one snapshot that a line of that order carries (404 otherwise). Order reads need \`product_configurator.snapshots.view\` and \`sales.orders.view\` only. With \`quoteId\`, lists the configurations of a quote of the selected organization (optionally narrowed by \`ids\`, at most ${SNAPSHOTS_MAX_IDS}); \`lineState\` is \`removed\` when no line of the quote carries the snapshot any more. At most ${MAX_SNAPSHOTS_PER_QUOTE} snapshots are read, oldest first; \`truncated\` is true when the quote has more. With \`id\`, returns one snapshot; its line is \`present\` when the quote line exists or an order line with the same id carries it, and a pending snapshot that no line carries answers 404. Quote and id reads need \`product_configurator.snapshots.view\` and \`sales.quotes.view\`.`,
      query: z.object({
        id: z.string().uuid().optional(),
        quoteId: z.string().uuid().optional(),
        orderId: z.string().uuid().optional().describe('Alone, or with `id` to read one snapshot the order carries'),
        ids: z.string().optional().describe('Comma-separated snapshot ids, with quoteId or orderId'),
      }),
      responses: [
        { status: 200, description: 'One snapshot (by id)', schema: snapshotSchema },
        {
          status: 200,
          description: 'Snapshots of the quote (by quoteId) or of the order (by orderId)',
          schema: z.object({
            items: z.array(snapshotSchema),
            truncated: z.boolean().describe(`True when the quote has more than ${MAX_SNAPSHOTS_PER_QUOTE} snapshots and only the oldest are listed`),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid query or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing configuration access, or sales access to the quote or order asked for', schema: errorResponseSchema },
        {
          status: 404,
          description: '`snapshot_not_found`, `quote_not_found` or `order_not_found` in the selected organization; with `orderId`, a snapshot no line of the order carries',
          schema: errorResponseSchema,
        },
      ],
    },
  },
}
