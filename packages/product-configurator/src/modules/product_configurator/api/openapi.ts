import { z, type ZodTypeAny } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  createCrudOpenApiFactory,
  createPagedListResponseSchema as createSharedPagedListResponseSchema,
  defaultCreateResponseSchema,
  defaultOkResponseSchema,
  type CrudOpenApiOptions,
} from '@open-mercato/shared/lib/openapi/crud'

export const productConfiguratorTag = 'Product Configurator'

export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
})

/** The definition DSL is recursive and overflows the OpenAPI generator, so it is documented as an opaque object. */
export const opaqueDefinitionSchema = z.record(z.string(), z.unknown()).describe('Configuration model definition (DSL schemaVersion 1)')

export const validationReportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      check: z.string(),
      code: z.string(),
      params: z.record(z.string(), z.unknown()),
      refs: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
})

export function createPagedListResponseSchema(itemSchema: ZodTypeAny) {
  return createSharedPagedListResponseSchema(itemSchema, { paginationMetaOptional: true })
}

const buildCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: productConfiguratorTag,
  defaultCreateResponseSchema,
  defaultOkResponseSchema,
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} scoped to the selected organization.`,
})

export function createProductConfiguratorCrudOpenApi(options: CrudOpenApiOptions): OpenApiRouteDoc {
  return buildCrudOpenApi(options)
}
