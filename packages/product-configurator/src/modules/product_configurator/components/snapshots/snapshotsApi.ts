import { z } from 'zod'

export const SNAPSHOTS_API = '/api/product_configurator/snapshots'

const rowSchema = z.object({ label: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), unit: z.string().nullable() })

/** The snapshot read model of `GET /snapshots` (spec "API Contracts"). */
export const snapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  quoteId: z.string(),
  quoteLineId: z.string().nullable(),
  lineState: z.enum(['present', 'removed']),
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

export function snapshotHref(snapshotId: string, quoteId?: string): string {
  const base = `/backend/product_configurator/snapshots/${encodeURIComponent(snapshotId)}`
  return quoteId ? `${base}?quoteId=${encodeURIComponent(quoteId)}` : base
}

/**
 * Opened from a quote, the snapshot is read through that quote (`quoteId` + `ids`), so access and the line
 * state are checked against the document the link came from; without it, by `id`.
 */
export function snapshotUrl(snapshotId: string, quoteId: string | null): string {
  if (quoteId) return `${SNAPSHOTS_API}?quoteId=${encodeURIComponent(quoteId)}&ids=${encodeURIComponent(snapshotId)}`
  return `${SNAPSHOTS_API}?id=${encodeURIComponent(snapshotId)}`
}

export type SnapshotLoad =
  | { status: 'ready'; snapshot: SnapshotReadModel }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error' }

export function snapshotLoadFromResponse(status: number, payload: unknown, snapshotId: string, byQuote: boolean): SnapshotLoad {
  if (status === 404) return { status: 'not_found' }
  if (status === 403) return { status: 'forbidden' }
  if (status !== 200) return { status: 'error' }
  if (byQuote) {
    const list = snapshotListSchema.safeParse(payload)
    if (!list.success) return { status: 'error' }
    const snapshot = list.data.items.find((item) => item.id === snapshotId)
    return snapshot ? { status: 'ready', snapshot } : { status: 'not_found' }
  }
  const parsed = snapshotSchema.safeParse(payload)
  return parsed.success ? { status: 'ready', snapshot: parsed.data } : { status: 'error' }
}
