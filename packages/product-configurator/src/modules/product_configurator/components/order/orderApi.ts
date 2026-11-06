import { z } from 'zod'
import {
  SNAPSHOT_IDS_PER_REQUEST,
  documentSnapshotsUrl,
  readConfiguredLineMarkers,
  readSnapshotList,
  type SnapshotList,
  type SnapshotReadModel,
} from '../snapshots/snapshotsApi'

export const ORDERS_LIST_HREF = '/backend/sales/orders'

export function orderHref(orderId: string): string {
  return `${ORDERS_LIST_HREF}/${encodeURIComponent(orderId)}`
}

/** The context the sales document page passes to `sales.document.detail.order:tabs` widgets. */
export const orderTabContextSchema = z.object({
  kind: z.string(),
  documentId: z.string().nullable().optional(),
  record: z.object({ id: z.string() }).passthrough().nullable().optional(),
})

export type OrderSnapshots = SnapshotList

/** Snapshots of the order's configured lines (`GET /snapshots?orderId=`); throws on any failure. */
export function loadOrderSnapshots(orderId: string): Promise<OrderSnapshots> {
  return readSnapshotList(documentSnapshotsUrl({ kind: 'order', id: orderId }))
}

/**
 * The snapshot of every configured order line, by order line id. A truncated list is completed with the
 * snapshot ids the order lines' configuration markers carry, read by id in chunks.
 */
export async function loadOrderConfiguredLines(orderId: string): Promise<Map<string, SnapshotReadModel>> {
  const list = await loadOrderSnapshots(orderId)
  const byLine = new Map<string, SnapshotReadModel>()
  const add = (items: SnapshotReadModel[]) => {
    for (const snapshot of items) if (snapshot.lineId && !byLine.has(snapshot.lineId)) byLine.set(snapshot.lineId, snapshot)
  }
  add(list.items)
  if (!list.truncated) return byLine
  const listed = new Set(list.items.map((snapshot) => snapshot.id))
  const markers = await readConfiguredLineMarkers({ kind: 'order', id: orderId })
  const missing = Array.from(new Set(markers.values())).filter((snapshotId) => !listed.has(snapshotId))
  for (let start = 0; start < missing.length; start += SNAPSHOT_IDS_PER_REQUEST) {
    const ids = missing.slice(start, start + SNAPSHOT_IDS_PER_REQUEST).join(',')
    add((await readSnapshotList(`${documentSnapshotsUrl({ kind: 'order', id: orderId })}&ids=${encodeURIComponent(ids)}`)).items)
  }
  return byLine
}

const CACHE_TTL_MS = 30_000

type CacheEntry = { promise: Promise<Map<string, SnapshotReadModel>>; createdAt: number }

const orderLinesCache = new Map<string, CacheEntry>()

/**
 * One load per order and organization scope for all cells of the "Configured" column: every row of the
 * items table renders its own cell, so they share it. `scopeVersion` (`useOrganizationScopeVersion`)
 * keeps a load made for another organization selection from being reused. Expired entries are dropped
 * on read; a failed load is not kept.
 */
export function loadOrderConfiguredLinesShared(orderId: string, scopeVersion: number, now = Date.now()): Promise<Map<string, SnapshotReadModel>> {
  for (const [key, entry] of orderLinesCache) {
    if (now - entry.createdAt >= CACHE_TTL_MS) orderLinesCache.delete(key)
  }
  const key = `${scopeVersion}:${orderId}`
  const cached = orderLinesCache.get(key)
  if (cached) return cached.promise
  const promise = loadOrderConfiguredLines(orderId)
  orderLinesCache.set(key, { promise, createdAt: now })
  promise.catch(() => {
    if (orderLinesCache.get(key)?.promise === promise) orderLinesCache.delete(key)
  })
  return promise
}

export function clearOrderSnapshotsCache(): void {
  orderLinesCache.clear()
}
