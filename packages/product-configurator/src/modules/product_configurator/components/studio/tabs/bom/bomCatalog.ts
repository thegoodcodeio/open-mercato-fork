"use client"

import * as React from 'react'
import { z } from 'zod'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { CATALOG_ITEMS_MAX_SKUS } from '../../../../data/validators'

export const CATALOG_ITEMS_API = '/api/product_configurator/catalog-items'

export type CatalogEntry =
  | { status: 'found'; title: string; unit: string | null }
  | { status: 'unknown' }
  | { status: 'ambiguous' }
  /** The request failed (network, 5xx, or no `catalog.products.view`); retried on the next check. */
  | { status: 'failed' }

/** Per-SKU answers shared by the BOM table and its row editor for the lifetime of the tab. */
export type CatalogCache = Map<string, Promise<CatalogEntry>>

const FAILED: CatalogEntry = { status: 'failed' }

const responseSchema = z.object({
  items: z.array(z.object({ sku: z.string(), title: z.string(), unit: z.string().nullable() })),
  unknown: z.array(z.string()),
  ambiguous: z.array(z.string()),
})

async function fetchChunk(skus: readonly string[]): Promise<Map<string, CatalogEntry>> {
  const entries = new Map<string, CatalogEntry>()
  const call = await apiCall(`${CATALOG_ITEMS_API}?skus=${encodeURIComponent(skus.join(','))}`).catch(() => null)
  const parsed = call?.ok ? responseSchema.safeParse(call.result) : null
  if (!parsed?.success) return entries
  for (const item of parsed.data.items) entries.set(item.sku, { status: 'found', title: item.title, unit: item.unit })
  for (const sku of parsed.data.unknown) entries.set(sku, { status: 'unknown' })
  for (const sku of parsed.data.ambiguous) entries.set(sku, { status: 'ambiguous' })
  return entries
}

/** Resolves SKUs in requests of at most 100, asking only for SKUs not already answered or in flight. */
export async function resolveCatalogSkus(skus: readonly string[], cache: CatalogCache): Promise<Map<string, CatalogEntry>> {
  const missing = skus.filter((sku) => !cache.has(sku))
  for (let start = 0; start < missing.length; start += CATALOG_ITEMS_MAX_SKUS) {
    const chunk = missing.slice(start, start + CATALOG_ITEMS_MAX_SKUS)
    const request = fetchChunk(chunk)
    for (const sku of chunk) {
      const entry = request.then((entries) => entries.get(sku) ?? FAILED)
      cache.set(sku, entry)
      void entry.then((resolved) => {
        if (resolved.status === 'failed' && cache.get(sku) === entry) cache.delete(sku)
      })
    }
  }
  const resolved = await Promise.all(skus.map(async (sku) => [sku, await (cache.get(sku) ?? FAILED)] as const))
  return new Map(resolved)
}

export type CatalogLookup = {
  entries: ReadonlyMap<string, CatalogEntry>
  /** True while the answer for the current SKUs is not in yet. */
  pending: boolean
}

/** Catalog titles and base units for `skus`, re-read when the set of SKUs changes. */
export function useCatalogItems(skus: readonly string[], cache: CatalogCache): CatalogLookup {
  const setKey = Array.from(new Set(skus))
    .sort((left, right) => left.localeCompare(right))
    .join('\n')
  const [lookup, setLookup] = React.useState<CatalogLookup & { key: string }>({ entries: new Map(), pending: false, key: '' })

  React.useEffect(() => {
    if (!setKey) {
      setLookup({ entries: new Map(), pending: false, key: '' })
      return
    }
    let cancelled = false
    setLookup((current) => ({ ...current, pending: true }))
    void resolveCatalogSkus(setKey.split('\n'), cache).then((entries) => {
      if (!cancelled) setLookup({ entries, pending: false, key: setKey })
    })
    return () => {
      cancelled = true
    }
  }, [cache, setKey])

  return { entries: lookup.entries, pending: lookup.pending || lookup.key !== setKey }
}

export type SkuUnitSummary = {
  /** Some SKUs are not answered yet. */
  checking: boolean
  /** The catalog could not be read for some SKUs. */
  unavailable: boolean
  unknown: string[]
  ambiguous: string[]
  /** Found SKUs without a base unit. */
  missingUnit: string[]
  units: Array<{ sku: string; unit: string }>
  /** The one unit every found SKU is sold in; `null` when there is none, units differ, or one is missing. */
  commonUnit: string | null
}

export function summarizeSkuUnits(skus: readonly string[], entries: ReadonlyMap<string, CatalogEntry>): SkuUnitSummary {
  const summary: SkuUnitSummary = { checking: false, unavailable: false, unknown: [], ambiguous: [], missingUnit: [], units: [], commonUnit: null }
  for (const sku of skus) {
    const entry = entries.get(sku)
    if (!entry) summary.checking = true
    else if (entry.status === 'failed') summary.unavailable = true
    else if (entry.status === 'unknown') summary.unknown.push(sku)
    else if (entry.status === 'ambiguous') summary.ambiguous.push(sku)
    else if (entry.unit === null) summary.missingUnit.push(sku)
    else summary.units.push({ sku, unit: entry.unit })
  }
  const distinct = distinctUnits(summary)
  if (!summary.checking && !summary.unavailable && summary.missingUnit.length === 0 && distinct.length === 1) summary.commonUnit = distinct[0]
  return summary
}

export function distinctUnits(summary: Pick<SkuUnitSummary, 'units'>): string[] {
  return Array.from(new Set(summary.units.map((entry) => entry.unit)))
}
