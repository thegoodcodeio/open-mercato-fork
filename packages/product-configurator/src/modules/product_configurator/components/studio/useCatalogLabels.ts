"use client"

import * as React from 'react'
import { z } from 'zod'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

const titledListSchema = z.object({ items: z.array(z.object({ id: z.string(), title: z.string().nullable().optional() })) })

const TITLE_TTL_MS = 60_000

const titleRequests = new Map<string, { request: Promise<string | null>; at: number }>()

/** `undefined` when the title could not be read, so the answer is not kept. */
async function fetchTitle(url: string, id: string): Promise<string | null | undefined> {
  const call = await apiCall(url).catch(() => null)
  const parsed = call?.ok ? titledListSchema.safeParse(call.result) : null
  if (!parsed?.success) return undefined
  return parsed.data.items.find((item) => item.id === id)?.title ?? null
}

/**
 * The header and the Overview tab ask for the same titles; one request per URL serves both for a minute.
 * A failed read is dropped, so the next mount asks again.
 */
function readTitle(url: string, id: string): Promise<string | null> {
  const cached = titleRequests.get(url)
  if (cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.request
  const entry = {
    request: fetchTitle(url, id).then((title) => {
      if (title === undefined && titleRequests.get(url) === entry) titleRequests.delete(url)
      return title ?? null
    }),
    at: Date.now(),
  }
  titleRequests.set(url, entry)
  return entry.request
}

/** Catalog titles for the studio header. Display only: a title that cannot be read is `null` and the header shows the id instead. */
export function useCatalogLabels(productId: string, priceKindId: string | null) {
  const [labels, setLabels] = React.useState<{ product: string | null; priceKind: string | null }>({ product: null, priceKind: null })

  React.useEffect(() => {
    let cancelled = false
    const productUrl = `/api/catalog/products?ids=${encodeURIComponent(productId)}&pageSize=1`
    const priceKindUrl = priceKindId ? `/api/product_configurator/price-kinds?ids=${encodeURIComponent(priceKindId)}&pageSize=1` : null
    Promise.all([
      readTitle(productUrl, productId),
      priceKindUrl && priceKindId ? readTitle(priceKindUrl, priceKindId) : Promise.resolve(null),
    ]).then(([product, priceKind]) => {
      if (!cancelled) setLabels({ product, priceKind })
    })
    return () => {
      cancelled = true
    }
  }, [priceKindId, productId])

  return labels
}
