import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { getEntityIds } from '@open-mercato/shared/lib/encryption/entityIds'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { SortDir, type QueryEngine } from '@open-mercato/shared/lib/query/types'

const READ_PAGE_SIZE = 100

export type ServiceResolver = Pick<CommandRuntimeContext['container'], 'resolve'>
export type QuoteScope = { tenantId: string; organizationId: string }

/** Features every session operation needs: the configurator grant plus sales visibility of the quote. */
export const SESSION_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.view'] as const

/** Finalising writes a quote line, so it needs quote edit rights on top of the configurator grant. */
export const FINALISE_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.manage'] as const

/** Snapshot reads by quote or by id need sales visibility of quotes. */
export const SNAPSHOT_QUOTE_FEATURES = ['product_configurator.snapshots.view', 'sales.quotes.view'] as const

/** Snapshot reads through an order (the order tab, the order items column) need sales visibility of orders instead. */
export const SNAPSHOT_ORDER_FEATURES = ['product_configurator.snapshots.view', 'sales.orders.view'] as const

/** Editing a configured line's commercial fields writes the quote line. */
export const LINE_UPDATE_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.manage'] as const

/** The quote header fields the configurator reads at request time; nothing here is stored by the module. */
export type QuoteHeader = {
  id: string
  organizationId: string
  quoteNumber: string | null
  status: string | null
  currencyCode: string
  channelId: string | null
  customerEntityId: string | null
  customerName: string | null
  updatedAt: string | null
}

type QuoteRow = {
  id: string
  organization_id?: string | null
  quote_number?: string | null
  status?: string | null
  currency_code?: string | null
  channel_id?: string | null
  customer_entity_id?: string | null
  customer_snapshot?: unknown
  updated_at?: string | Date | null
}

type UserRow = { id: string; name?: string | null; email?: string | null }

type RbacService = {
  userHasAllFeatures(userId: string, required: string[], scope: { tenantId: string | null; organizationId: string | null }): Promise<boolean>
}

export function tryResolve<T>(container: ServiceResolver, name: string): T | null {
  try {
    return (container.resolve(name) as T | undefined) ?? null
  } catch {
    return null
  }
}

type SalesEntity = 'sales_quote' | 'sales_order' | 'sales_quote_line' | 'sales_order_line' | 'sales_tax_rate'

function salesEntityId(entity: SalesEntity): string {
  const entityId = getEntityIds().sales?.[entity]
  if (!entityId) throw new Error(`[internal] product_configurator: sales entity ${entity} is not registered`)
  return entityId
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return readObject(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readText(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Same precedence as the sales quote previews: the customer display name, then the contact's name. */
export function customerNameFromSnapshot(snapshot: unknown): string | null {
  const root = readObject(snapshot)
  const customer = readObject(root?.customer)
  const contact = readObject(root?.contact)
  const displayName = readText(customer, 'displayName')
  if (displayName) return displayName
  const parts = [readText(contact, 'preferredName') ?? readText(contact, 'firstName'), readText(contact, 'lastName')]
  const name = parts.filter((part): part is string => part !== null).join(' ')
  return name.length > 0 ? name : null
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

/**
 * Reads one quote of the selected organization through `queryEngine` (decrypted, soft-deleted
 * quotes excluded). Null means the quote is not visible in this scope, was deleted or converted.
 */
export async function readQuoteHeader(container: ServiceResolver, quoteId: string, scope: QuoteScope): Promise<QuoteHeader | null> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const result = await queryEngine.query<QuoteRow>(salesEntityId('sales_quote'), {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    filters: { id: { $eq: quoteId } },
    fields: [
      'id',
      'organization_id',
      'quote_number',
      'status',
      'currency_code',
      'channel_id',
      'customer_entity_id',
      'customer_snapshot',
      'updated_at',
    ],
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items[0]
  if (!row || row.id !== quoteId) return null
  return {
    id: row.id,
    organizationId: row.organization_id ?? scope.organizationId,
    quoteNumber: row.quote_number ?? null,
    status: row.status ?? null,
    currencyCode: row.currency_code ?? '',
    channelId: row.channel_id ?? null,
    customerEntityId: row.customer_entity_id ?? null,
    customerName: customerNameFromSnapshot(row.customer_snapshot),
    updatedAt: toIso(row.updated_at),
  }
}

/** Whether an order is readable in the selected organization (soft-deleted orders excluded). */
export async function orderExists(container: ServiceResolver, orderId: string, scope: QuoteScope): Promise<boolean> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const result = await queryEngine.query<{ id: string }>(salesEntityId('sales_order'), {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    filters: { id: { $eq: orderId } },
    fields: ['id'],
    page: { page: 1, pageSize: 1 },
  })
  return result.items[0]?.id === orderId
}

/** The numeric rate of a sales tax rate of the selected organization (soft-deleted rates excluded); null when unknown. */
export async function readTaxRate(container: ServiceResolver, taxRateId: string, scope: QuoteScope): Promise<string | null> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const result = await queryEngine.query<{ id: string; rate?: string | number | null }>(salesEntityId('sales_tax_rate'), {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    filters: { id: { $eq: taxRateId } },
    fields: ['id', 'rate'],
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items[0]
  if (!row || row.id !== taxRateId || row.rate === null || row.rate === undefined) return null
  return String(row.rate)
}

export type PricingPartyKind = 'customer' | 'channel'

function pricingPartyEntityId(kind: PricingPartyKind): string | null {
  const entityIds = getEntityIds()
  return (kind === 'customer' ? entityIds.customers?.customer_entity : entityIds.sales?.sales_channel) ?? null
}

/**
 * Whether a customer (company or person) or a sales channel exists in the selected organization, read
 * through `queryEngine` (soft-deleted rows excluded). A pricing context must name only these, because
 * pricing reveals the customer's groups and the channel's prices.
 */
export async function pricingPartyExists(container: ServiceResolver, kind: PricingPartyKind, id: string, scope: QuoteScope): Promise<boolean> {
  const entityId = pricingPartyEntityId(kind)
  if (!entityId) return false
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const result = await queryEngine.query<{ id: string }>(entityId, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    filters: { id: { $eq: id } },
    fields: ['id'],
    page: { page: 1, pageSize: 1 },
  })
  return result.items[0]?.id === id
}

/**
 * Re-checks route features inside commands with the wildcard-aware RBAC service, so a command
 * dispatched outside its route (AI tools, other modules) still needs sales visibility. Fails closed
 * when there is no authenticated actor or no RBAC service.
 */
export async function assertFeatures(ctx: CommandRuntimeContext, features: readonly string[], scope: QuoteScope): Promise<string> {
  const userId = ctx.auth?.sub ?? null
  const rbac = tryResolve<RbacService>(ctx.container, 'rbacService')
  if (userId && rbac && (await rbac.userHasAllFeatures(userId, [...features], scope))) return userId
  const { translate } = await resolveTranslations()
  throw new CrudHttpError(403, {
    error: translate('product_configurator.errors.forbidden', 'You do not have access to this configuration.'),
    code: 'forbidden',
  })
}

/** Display names of users (name, else email) read at request time and never stored. */
export async function readUserDisplayNames(container: ServiceResolver, userIds: string[], tenantId: string): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  const ids = Array.from(new Set(userIds))
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  for (let start = 0; start < ids.length; start += READ_PAGE_SIZE) {
    const chunk = ids.slice(start, start + READ_PAGE_SIZE)
    const result = await queryEngine.query<UserRow>(getEntityIds().auth.user, {
      tenantId,
      filters: { id: { $in: chunk } },
      fields: ['id', 'name', 'email'],
      page: { page: 1, pageSize: chunk.length },
    })
    for (const row of result.items) names.set(row.id, row.name?.trim() || row.email || null)
  }
  return names
}

/** The marker finalise writes into a configured line's `configuration`. */
export type ConfiguredLineMarker = { snapshotId: string | null; modelVersionId: string | null; hash: string | null; summary: string | null }

export const CONFIGURATION_MARKER_KEY = 'productConfigurator'

export function hasConfigurationMarker(configuration: unknown): boolean {
  const root = readObject(configuration)
  return root !== null && Object.prototype.hasOwnProperty.call(root, CONFIGURATION_MARKER_KEY)
}

export function readConfigurationMarker(configuration: unknown): ConfiguredLineMarker | null {
  const root = readObject(configuration)
  if (!root || !Object.prototype.hasOwnProperty.call(root, CONFIGURATION_MARKER_KEY)) return null
  const marker = readObject(root[CONFIGURATION_MARKER_KEY])
  return {
    snapshotId: readText(marker, 'snapshotId'),
    modelVersionId: readText(marker, 'modelVersionId'),
    hash: readText(marker, 'hash'),
    summary: typeof marker?.summary === 'string' ? marker.summary : null,
  }
}

export type DocumentKind = 'quote' | 'order'

/** The stored fields of a quote or order line that the configurator reads (reconcile, guard, snapshot reads). */
export type StoredLine = {
  id: string
  parentId: string | null
  name: string | null
  configuration: Record<string, unknown> | null
  productId: string | null
  productVariantId: string | null
  currencyCode: string | null
  quantity: string | null
  quantityUnit: string | null
  unitPriceNet: string | null
  taxAmount: string | null
  totalNetAmount: string | null
  totalGrossAmount: string | null
}

type LineRow = {
  id: string
  quote_id?: string | null
  order_id?: string | null
  name?: string | null
  configuration?: unknown
  product_id?: string | null
  product_variant_id?: string | null
  currency_code?: string | null
  quantity?: string | number | null
  quantity_unit?: string | null
  unit_price_net?: string | number | null
  tax_amount?: string | number | null
  total_net_amount?: string | number | null
  total_gross_amount?: string | number | null
}

const LINE_FIELDS = [
  'id',
  'name',
  'configuration',
  'product_id',
  'product_variant_id',
  'currency_code',
  'quantity',
  'quantity_unit',
  'unit_price_net',
  'tax_amount',
  'total_net_amount',
  'total_gross_amount',
]

function parentColumn(kind: DocumentKind): 'quote_id' | 'order_id' {
  return kind === 'quote' ? 'quote_id' : 'order_id'
}

function lineEntity(kind: DocumentKind): SalesEntity {
  return kind === 'quote' ? 'sales_quote_line' : 'sales_order_line'
}

function toText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

function toStoredLine(row: LineRow, kind: DocumentKind): StoredLine {
  return {
    id: row.id,
    parentId: (kind === 'quote' ? row.quote_id : row.order_id) ?? null,
    name: row.name ?? null,
    configuration: readObject(row.configuration),
    productId: row.product_id ?? null,
    productVariantId: row.product_variant_id ?? null,
    currencyCode: row.currency_code ?? null,
    quantity: toText(row.quantity),
    quantityUnit: row.quantity_unit ?? null,
    unitPriceNet: toText(row.unit_price_net),
    taxAmount: toText(row.tax_amount),
    totalNetAmount: toText(row.total_net_amount),
    totalGrossAmount: toText(row.total_gross_amount),
  }
}

/**
 * Every line of one quote or order, read live through `queryEngine` in the given scope. `queryEngine`
 * returns 20 rows unless asked otherwise, so this pages through all lines 100 at a time, ordered by id.
 */
export async function readDocumentLines(
  container: ServiceResolver,
  kind: DocumentKind,
  parentId: string,
  scope: QuoteScope,
): Promise<StoredLine[]> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const column = parentColumn(kind)
  const lines: StoredLine[] = []
  for (let page = 1; ; page += 1) {
    const result = await queryEngine.query<LineRow>(salesEntityId(lineEntity(kind)), {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      filters: { [column]: { $eq: parentId } },
      fields: [...LINE_FIELDS, column],
      sort: [{ field: 'id', dir: SortDir.Asc }],
      page: { page, pageSize: READ_PAGE_SIZE },
    })
    for (const row of result.items) lines.push(toStoredLine(row, kind))
    if (result.items.length < READ_PAGE_SIZE) return lines
  }
}

/**
 * Lines of one quote or order of the selected organization by id, a bounded read for callers that
 * know which lines they need (`READ_PAGE_SIZE` ids per query).
 */
export async function readDocumentLinesByIds(
  container: ServiceResolver,
  kind: DocumentKind,
  parentId: string,
  ids: string[],
  scope: QuoteScope,
): Promise<StoredLine[]> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const column = parentColumn(kind)
  const uniqueIds = Array.from(new Set(ids))
  const lines: StoredLine[] = []
  for (let start = 0; start < uniqueIds.length; start += READ_PAGE_SIZE) {
    const chunk = uniqueIds.slice(start, start + READ_PAGE_SIZE)
    const result = await queryEngine.query<LineRow>(salesEntityId(lineEntity(kind)), {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      filters: { id: { $in: chunk }, [column]: { $eq: parentId } },
      fields: [...LINE_FIELDS, column],
      page: { page: 1, pageSize: chunk.length },
    })
    for (const row of result.items) lines.push(toStoredLine(row, kind))
  }
  return lines
}

export type QuoteLineDetails = {
  quoteId: string | null
  name: string | null
  comment: string | null
  discountPercent: string | null
  discountAmount: string | null
  taxRate: string | null
}

type QuoteLineDetailsRow = {
  id: string
  quote_id?: string | null
  name?: string | null
  comment?: string | null
  discount_percent?: string | number | null
  discount_amount?: string | number | null
  tax_rate?: string | number | null
}

/** The commercial fields of one quote line in the selected organization, for the audit log of an edit. */
export async function readQuoteLineDetails(container: ServiceResolver, lineId: string, scope: QuoteScope): Promise<QuoteLineDetails | null> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const result = await queryEngine.query<QuoteLineDetailsRow>(salesEntityId('sales_quote_line'), {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    filters: { id: { $eq: lineId } },
    fields: ['id', 'quote_id', 'name', 'comment', 'discount_percent', 'discount_amount', 'tax_rate'],
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items[0]
  if (!row || row.id !== lineId) return null
  return {
    quoteId: row.quote_id ?? null,
    name: row.name ?? null,
    comment: row.comment ?? null,
    discountPercent: toText(row.discount_percent),
    discountAmount: toText(row.discount_amount),
    taxRate: toText(row.tax_rate),
  }
}

/** The line of a quote or order whose configuration marker references `snapshotId`, if one was committed. */
export async function findLineCarryingSnapshot(
  container: ServiceResolver,
  kind: DocumentKind,
  parentId: string,
  snapshotId: string,
  scope: QuoteScope,
): Promise<StoredLine | null> {
  const lines = await readDocumentLines(container, kind, parentId, scope)
  return lines.find((line) => readConfigurationMarker(line.configuration)?.snapshotId === snapshotId) ?? null
}

/**
 * Lines by id within the tenant, for the configured line guard. The organization is not narrowed on
 * purpose: a body naming another organization must not hide a configured line from the guard.
 */
export async function readStoredLines(
  container: ServiceResolver,
  kind: DocumentKind,
  ids: string[],
  tenantId: string,
): Promise<Map<string, StoredLine>> {
  const lines = new Map<string, StoredLine>()
  const uniqueIds = Array.from(new Set(ids))
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  for (let start = 0; start < uniqueIds.length; start += READ_PAGE_SIZE) {
    const chunk = uniqueIds.slice(start, start + READ_PAGE_SIZE)
    const result = await queryEngine.query<LineRow>(salesEntityId(lineEntity(kind)), {
      tenantId,
      filters: { id: { $in: chunk } },
      fields: [...LINE_FIELDS, parentColumn(kind)],
      page: { page: 1, pageSize: chunk.length },
    })
    for (const row of result.items) lines.set(row.id, toStoredLine(row, kind))
  }
  return lines
}

/**
 * Lines by id in whichever tenant they belong to, for the guard when the write has no trusted tenant
 * (a super administrator without a tenant, a system dispatch): sales then writes the line of the
 * quote it locks, whatever tenant the body names. Only judges the write, never returned. The tenants
 * are found first by id alone (`id` and `tenant_id`, nothing decrypted), then every line is read in
 * its own tenant like `readStoredLines`. `nominalTenantId` only satisfies `queryEngine`, which wants
 * one even when its automatic scope is off.
 */
export async function readStoredLinesInAnyTenant(
  container: ServiceResolver,
  kind: DocumentKind,
  ids: string[],
  nominalTenantId: string,
): Promise<Map<string, StoredLine>> {
  const idsByTenant = new Map<string, string[]>()
  const uniqueIds = Array.from(new Set(ids))
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  for (let start = 0; start < uniqueIds.length; start += READ_PAGE_SIZE) {
    const chunk = uniqueIds.slice(start, start + READ_PAGE_SIZE)
    const result = await queryEngine.query<{ id: string; tenant_id?: string | null }>(salesEntityId(lineEntity(kind)), {
      tenantId: nominalTenantId,
      omitAutomaticTenantOrgScope: true,
      decryptEncryptedFields: false,
      filters: { id: { $in: chunk } },
      fields: ['id', 'tenant_id'],
      page: { page: 1, pageSize: chunk.length },
    })
    for (const row of result.items) {
      if (!row.tenant_id) continue
      idsByTenant.set(row.tenant_id, [...(idsByTenant.get(row.tenant_id) ?? []), row.id])
    }
  }
  const lines = new Map<string, StoredLine>()
  for (const [tenantId, tenantLineIds] of idsByTenant) {
    for (const [id, line] of await readStoredLines(container, kind, tenantLineIds, tenantId)) lines.set(id, line)
  }
  return lines
}
