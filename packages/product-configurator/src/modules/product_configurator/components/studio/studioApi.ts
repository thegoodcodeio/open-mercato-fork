import { z } from 'zod'
import type { ValidationReport } from '../../lib/validation/types'
import { VALIDATION_CHECKS, VALIDATION_CODES } from '../../lib/validation/types'
import type { StudioModelDetail } from './studioState'

export const MODELS_API = '/api/product_configurator/models'
export const VALIDATE_API = '/api/product_configurator/models/validate'
export const PUBLISH_API = '/api/product_configurator/models/publish'
export const MODELS_LIST_HREF = '/backend/product_configurator/models'
export const MODEL_RESOURCE_KIND = 'product_configurator.model'

const modelDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  modelKey: z.string(),
  productId: z.string(),
  currencyCode: z.string(),
  updatedAt: z.string().nullable().optional(),
  latestVersion: z
    .object({ id: z.string(), version: z.number(), hash: z.string(), publishedAt: z.string() })
    .nullable()
    .optional(),
  hasUnpublishedChanges: z.boolean().optional(),
  draftDefinition: z.unknown(),
})

const modelListSchema = z.object({ items: z.array(z.unknown()) })

export function parseModelDetail(payload: unknown): StudioModelDetail | null {
  const list = modelListSchema.safeParse(payload)
  const parsed = modelDetailSchema.safeParse(list.success ? list.data.items[0] : payload)
  if (!parsed.success) return null
  const detail = parsed.data
  return {
    id: detail.id,
    title: detail.title,
    modelKey: detail.modelKey,
    productId: detail.productId,
    currencyCode: detail.currencyCode,
    updatedAt: detail.updatedAt ?? null,
    latestVersion: detail.latestVersion ?? null,
    hasUnpublishedChanges: detail.hasUnpublishedChanges ?? false,
    draftDefinition: detail.draftDefinition,
  }
}

export function modelDetailUrl(modelId: string): string {
  return `${MODELS_API}?id=${encodeURIComponent(modelId)}`
}

const issueParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])

const refSchema = z.union([
  z.object({ kind: z.literal('path'), path: z.string() }),
  z.object({ kind: z.enum(['feature', 'formula', 'lookup', 'rule', 'bom', 'product', 'priceKind']), key: z.string() }),
])

const reportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      check: z.enum(VALIDATION_CHECKS),
      code: z.enum(VALIDATION_CODES),
      params: z.record(z.string(), issueParamSchema),
      refs: z.array(refSchema),
    }),
  ),
})

export function parseValidationReport(payload: unknown): ValidationReport | null {
  const parsed = reportSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

const savedSchema = z.object({ updatedAt: z.string(), draftHash: z.string() })
const publishedSchema = z.object({ modelVersionId: z.string(), version: z.number(), hash: z.string(), updatedAt: z.string() })

export function parseSaveResponse(payload: unknown): z.infer<typeof savedSchema> | null {
  const parsed = savedSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

export function parsePublishResponse(payload: unknown): z.infer<typeof publishedSchema> | null {
  const parsed = publishedSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Reads `code` and `report` from an error thrown by `apiCallOrThrow` (it copies the JSON body onto the error). */
export function readErrorBody(error: unknown): { status: number | null; code: string | null; report: ValidationReport | null } {
  if (!error || typeof error !== 'object') return { status: null, code: null, report: null }
  const status = 'status' in error && typeof error.status === 'number' ? error.status : null
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  const report = 'report' in error ? parseValidationReport(error.report) : null
  return { status, code, report }
}
