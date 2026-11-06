import { z } from 'zod'
import { ORGANIZATION_SCOPE_REQUIRED_ERROR_CODE } from '@open-mercato/shared/lib/auth/organizationScope'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export const SNAPSHOTS_API = '/api/product_configurator/snapshots'

const rowSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().nullable(),
  decimals: z.number().int().optional(),
})

/** The snapshot read model of `GET /snapshots` (spec "API Contracts"). */
export const snapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  quoteId: z.string(),
  quoteLineId: z.string().nullable(),
  lineState: z.enum(['present', 'removed']),
  /** The line carrying the snapshot in the document asked for (the order line for `orderId`); null when removed. */
  lineId: z.string().nullable().optional(),
  lineName: z.string().nullable(),
  modelTitle: z.string().nullable(),
  modelVersion: z.object({ id: z.string(), version: z.number().int().nullable(), hash: z.string() }),
  summary: z.string(),
  selectionRows: z.array(rowSchema),
  calculatedRows: z.array(rowSchema),
  specification: z.array(z.object({ label: z.string(), value: z.string() })),
  bom: z.array(z.object({ sku: z.string(), label: z.string(), quantity: z.string(), uom: z.string(), unitPrice: z.string(), total: z.string() })),
  netPrice: z.string(),
  currencyCode: z.string(),
  warnings: z.array(z.object({ ruleId: z.string(), message: z.string() })),
  hash: z.string(),
  createdAt: z.string(),
})

export type SnapshotReadModel = z.infer<typeof snapshotSchema>
export type SnapshotRow = z.infer<typeof rowSchema>

/** `truncated`: the quote has more snapshots than the list returns (only the oldest are listed). */
export const snapshotListSchema = z.object({ items: z.array(snapshotSchema), truncated: z.boolean().optional() })

/** The sales document a snapshot is opened from; the API checks access against it. */
export type SnapshotDocument = { kind: 'quote' | 'order'; id: string }

const DOCUMENT_PARAM = { quote: 'quoteId', order: 'orderId' } as const

export function snapshotHref(snapshotId: string, document?: SnapshotDocument): string {
  const base = `/backend/product_configurator/snapshots/${encodeURIComponent(snapshotId)}`
  return document ? `${base}?${DOCUMENT_PARAM[document.kind]}=${encodeURIComponent(document.id)}` : base
}

/** The document a snapshot page was opened from (`?quoteId=` or `?orderId=`), or null. */
export function snapshotDocumentFromParams(params: { get: (name: string) => string | null } | null): SnapshotDocument | null {
  const quoteId = params?.get('quoteId')
  if (quoteId) return { kind: 'quote', id: quoteId }
  const orderId = params?.get('orderId')
  return orderId ? { kind: 'order', id: orderId } : null
}

/**
 * Opened from a quote, the snapshot is read through that quote (`quoteId` + `ids`); from an order, by `id` and
 * `orderId`. Access and the line state are checked against the document the link came from; without one, by `id`.
 */
export function snapshotUrl(snapshotId: string, document: SnapshotDocument | null): string {
  if (document?.kind === 'quote') return `${SNAPSHOTS_API}?quoteId=${encodeURIComponent(document.id)}&ids=${encodeURIComponent(snapshotId)}`
  if (document?.kind === 'order') return `${SNAPSHOTS_API}?id=${encodeURIComponent(snapshotId)}&orderId=${encodeURIComponent(document.id)}`
  return `${SNAPSHOTS_API}?id=${encodeURIComponent(snapshotId)}`
}

/** Snapshots carried by the lines of a document, oldest first. */
export function documentSnapshotsUrl(document: SnapshotDocument): string {
  return `${SNAPSHOTS_API}?${DOCUMENT_PARAM[document.kind]}=${encodeURIComponent(document.id)}`
}

/** Most snapshot ids one `GET /snapshots?ids=` accepts. */
export const SNAPSHOT_IDS_PER_REQUEST = 100

/** The API answers 400 `organization_scope_required` while all organizations are selected. */
export class OrganizationRequiredError extends Error {
  constructor() {
    super('[internal] organization_scope_required')
  }
}

const errorCodeSchema = z.object({ code: z.string() }).passthrough()

export function isOrganizationRequired(status: number, payload: unknown): boolean {
  return status === 400 && errorCodeSchema.safeParse(payload).data?.code === ORGANIZATION_SCOPE_REQUIRED_ERROR_CODE
}

export type SnapshotList = { items: SnapshotReadModel[]; truncated: boolean }

/** A snapshot list read; throws `OrganizationRequiredError` without a selected organization and on any other failure. */
export async function readSnapshotList(url: string): Promise<SnapshotList> {
  const call = await apiCall<unknown>(url, { cache: 'no-store' })
  if (isOrganizationRequired(call.status, call.result)) throw new OrganizationRequiredError()
  if (!call.ok) throw new Error(`[internal] snapshots answered ${call.status}`)
  const parsed = snapshotListSchema.safeParse(call.result)
  if (!parsed.success) throw new Error('[internal] unexpected snapshots payload')
  return { items: parsed.data.items, truncated: parsed.data.truncated === true }
}

const SALES_LINES_API: Record<SnapshotDocument['kind'], string> = {
  quote: '/api/sales/quote-lines',
  order: '/api/sales/order-lines',
}
const LINES_PAGE_SIZE = 100
const LINES_MAX_PAGES = 200

const linePageSchema = z.object({ items: z.array(z.object({ id: z.string(), configuration: z.unknown().optional() }).passthrough()) })

/** `configuration` is JSON; it is parsed here if a list answers it as text, as the server-side line reads do. */
function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const lineMarkerSchema = z.preprocess(
  parseJsonText,
  z.object({ productConfigurator: z.object({ snapshotId: z.string().uuid() }).passthrough() }).passthrough(),
)

/**
 * Snapshot id per line id of a document, from the marker finalise writes into a configured line's
 * `configuration`. Used when `GET /snapshots` is truncated, so the list alone is not complete.
 */
export async function readConfiguredLineMarkers(document: SnapshotDocument): Promise<Map<string, string>> {
  const markers = new Map<string, string>()
  for (let page = 1; page <= LINES_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ [DOCUMENT_PARAM[document.kind]]: document.id, page: String(page), pageSize: String(LINES_PAGE_SIZE) })
    const call = await apiCall<unknown>(`${SALES_LINES_API[document.kind]}?${params.toString()}`, { cache: 'no-store' })
    if (isOrganizationRequired(call.status, call.result)) throw new OrganizationRequiredError()
    if (!call.ok) throw new Error(`[internal] document lines answered ${call.status}`)
    const parsed = linePageSchema.safeParse(call.result)
    if (!parsed.success) throw new Error('[internal] unexpected document lines payload')
    for (const line of parsed.data.items) {
      const marker = lineMarkerSchema.safeParse(line.configuration)
      if (marker.success) markers.set(line.id, marker.data.productConfigurator.snapshotId)
    }
    if (parsed.data.items.length < LINES_PAGE_SIZE) return markers
  }
  throw new Error('[internal] document has more lines than can be read')
}

export type SnapshotLoad =
  | { status: 'ready'; snapshot: SnapshotReadModel }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error' }

export function snapshotLoadFromResponse(status: number, payload: unknown, snapshotId: string, document: SnapshotDocument | null): SnapshotLoad {
  if (status === 404) return { status: 'not_found' }
  if (status === 403) return { status: 'forbidden' }
  if (status !== 200) return { status: 'error' }
  if (document?.kind === 'quote') {
    const list = snapshotListSchema.safeParse(payload)
    if (!list.success) return { status: 'error' }
    const snapshot = list.data.items.find((item) => item.id === snapshotId)
    return snapshot ? { status: 'ready', snapshot } : { status: 'not_found' }
  }
  const parsed = snapshotSchema.safeParse(payload)
  return parsed.success ? { status: 'ready', snapshot: parsed.data } : { status: 'error' }
}
