import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CatalogPriceRowService } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CATALOG_ITEMS_MAX_SKUS, catalogItemsQuerySchema } from '../../data/validators'
import { resolveRouteContext, routeErrorResponse } from '../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../openapi'

export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['product_configurator.models.manage', 'catalog.products.view'],
  },
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const { skus } = catalogItemsQuerySchema.parse({ skus: new URL(req.url).searchParams.get('skus') ?? '' })
    if (skus.length > CATALOG_ITEMS_MAX_SKUS) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(400, {
        error: translate('product_configurator.errors.too_many_skus', 'Ask for at most 100 SKUs at a time.'),
        code: 'too_many_skus',
        limit: CATALOG_ITEMS_MAX_SKUS,
      })
    }
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    const catalogPriceRowService = context.ctx.container.resolve<CatalogPriceRowService>('catalogPriceRowService')
    const resolution = await catalogPriceRowService.resolveSkus(em, skus, context.scope)
    const ambiguous = new Set(resolution.ambiguous)
    return NextResponse.json({
      items: skus.flatMap((sku) => {
        const item = resolution.items.get(sku)
        return item ? [{ sku: item.sku, title: item.title, unit: item.unit }] : []
      }),
      unknown: skus.filter((sku) => !resolution.items.has(sku) && !ambiguous.has(sku)),
      ambiguous: skus.filter((sku) => ambiguous.has(sku)),
    })
  } catch (error) {
    return routeErrorResponse(error, 'catalog_items_read')
  }
}

const catalogItemsResponseSchema = z.object({
  items: z.array(z.object({ sku: z.string(), title: z.string(), unit: z.string().nullable() })),
  unknown: z.array(z.string()),
  ambiguous: z.array(z.string()),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Catalog items for the model studio',
  methods: {
    GET: {
      summary: 'Resolve SKUs to catalog titles and base units',
      description:
        'Resolves up to 100 comma-separated SKUs against live catalog products and variants of the selected organization. `unit` is the base unit price tiers use. SKUs found on both a product and a variant are listed in `ambiguous`.',
      query: z.object({ skus: z.string().describe('Comma-separated SKUs, at most 100') }),
      responses: [{ status: 200, description: 'Resolved items', schema: catalogItemsResponseSchema }],
      errors: [
        { status: 400, description: 'More than 100 SKUs, none given, or no single organization selected', schema: errorResponseSchema },
      ],
    },
  },
}
