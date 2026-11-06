"use client"

import * as React from 'react'
import { resolveCatalogSkus, type CatalogCache, type CatalogEntry } from '../bom/bomCatalog'

const CHECK_DELAY_MS = 400

/** `unavailable`: the check could not run (no catalog access, network error); Validate still checks the saved draft. */
export type SkuStatus =
  | { state: 'found'; title: string }
  | { state: 'unknown' }
  | { state: 'ambiguous' }
  | { state: 'unavailable' }

function toSkuStatus(entry: CatalogEntry): SkuStatus {
  switch (entry.status) {
    case 'found':
      return { state: 'found', title: entry.title }
    case 'unknown':
      return { state: 'unknown' }
    case 'ambiguous':
      return { state: 'ambiguous' }
    case 'failed':
      return { state: 'unavailable' }
  }
}

/**
 * Catalog status of the SKUs shown in the row editor. New SKUs are checked after a short pause, so typing a
 * SKU sends one request; answered SKUs are not asked for again while the editor is open, failed ones are
 * retried on the next check.
 */
export function useSkuCheck(skus: readonly string[], enabled: boolean): ReadonlyMap<string, SkuStatus> {
  const [statuses, setStatuses] = React.useState<ReadonlyMap<string, SkuStatus>>(() => new Map())
  const [cache] = React.useState<CatalogCache>(() => new Map())
  const mounted = React.useRef(true)
  const wantedKey = enabled ? [...new Set(skus.map((sku) => sku.trim()).filter((sku) => sku !== ''))].join('\n') : ''

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  React.useEffect(() => {
    const pending = wantedKey === '' ? [] : wantedKey.split('\n').filter((sku) => !cache.has(sku))
    if (pending.length === 0) return
    const timer = setTimeout(() => {
      void resolveCatalogSkus(pending, cache).then((entries) => {
        if (!mounted.current) return
        setStatuses((current) => new Map([...current, ...[...entries].map(([sku, entry]) => [sku, toSkuStatus(entry)] as const)]))
      })
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [cache, wantedKey])

  return statuses
}
