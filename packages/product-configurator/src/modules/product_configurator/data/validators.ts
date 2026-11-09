import { z } from 'zod'

export const DEFINITION_LIMITS = {
  features: 200,
  rules: 500,
  formulas: 100,
  lookups: 100,
  lookupRows: 1000,
  bomLines: 500,
  conditionsPerRule: 50,
  definitionBytes: 512 * 1024,
  evaluateRequestBytes: 64 * 1024,
  expressionDepth: 32,
  jsonNestingDepth: 64,
} as const

export const FORMULA_MAX_DECIMALS = 6

export const INCLUDES_TOKEN_SEPARATOR = /\s+/

/** Keys index plain-object records at runtime, so names inherited from `Object.prototype` are not keys. */
const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((key) => !(key in Object.prototype), { message: 'reserved_key' })

const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/)

const finiteNumber = z.number()
const orderSchema = z.number().int()
const selectionValueSchema = z.union([z.string(), finiteNumber, z.boolean()])

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length
}

// Measured iteratively before JSON.stringify and the recursive zod schemas, which overflow the stack on deeply nested input.
export function jsonNestingDepth(value: unknown): number {
  let deepest = 0
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }]
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    const { node } = entry
    if (node === null || typeof node !== 'object') continue
    const depth = entry.depth + 1
    deepest = Math.max(deepest, depth)
    if (depth > DEFINITION_LIMITS.jsonNestingDepth) return depth
    for (const child of Object.values(node)) pending.push({ node: child, depth })
  }
  return deepest
}

export function expressionDepth(expression: unknown): number {
  let deepest = 0
  const pending: Array<{ node: unknown; depth: number }> = [{ node: expression, depth: 1 }]
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    const { node, depth } = entry
    if (node === null || typeof node !== 'object') continue
    deepest = Math.max(deepest, depth)
    if (depth > DEFINITION_LIMITS.expressionDepth) return depth
    if ('left' in node) pending.push({ node: node.left, depth: depth + 1 })
    if ('right' in node) pending.push({ node: node.right, depth: depth + 1 })
  }
  return deepest
}

function maxJsonBytes(limit: number) {
  return (value: unknown, ctx: z.RefinementCtx) => {
    if (jsonNestingDepth(value) > DEFINITION_LIMITS.jsonNestingDepth) {
      ctx.addIssue({ code: 'custom', message: 'too_deep', params: { limit: DEFINITION_LIMITS.jsonNestingDepth } })
      return
    }
    if (jsonByteLength(value) > limit) {
      ctx.addIssue({ code: 'custom', message: 'too_large', params: { limit } })
    }
  }
}

const orderingOps = ['gt', 'gte', 'lt', 'lte'] as const

const compareConditionSchema = z
  .object({
    kind: z.literal('compare'),
    featureKey: keySchema,
    op: z.enum(['eq', 'neq', ...orderingOps]),
    value: selectionValueSchema,
  })
  .strict()
  .superRefine((condition, ctx) => {
    if (condition.op !== 'eq' && condition.op !== 'neq' && typeof condition.value !== 'number') {
      ctx.addIssue({ code: 'custom', message: 'ordering_value_not_numeric', path: ['value'] })
    }
  })

const includesTokenSchema = z
  .string()
  .min(1)
  .refine((value) => value.split(INCLUDES_TOKEN_SEPARATOR).length === 1, { message: 'single_token_required' })

const includesConditionSchema = z
  .object({ kind: z.literal('includes'), featureKey: keySchema, value: includesTokenSchema })
  .strict()

const notIncludesConditionSchema = z
  .object({ kind: z.literal('not_includes'), featureKey: keySchema, value: includesTokenSchema })
  .strict()

const notInLookupConditionSchema = z
  .object({ kind: z.literal('not_in_lookup'), featureKey: keySchema, lookupKey: keySchema, keyedBy: keySchema })
  .strict()

const calculatedConditionSchema = z
  .object({ kind: z.literal('calculated'), formulaKey: keySchema, op: z.enum(orderingOps), value: finiteNumber })
  .strict()

export const conditionSchema = z.discriminatedUnion('kind', [
  compareConditionSchema,
  includesConditionSchema,
  notIncludesConditionSchema,
  notInLookupConditionSchema,
  calculatedConditionSchema,
])

const conditionListSchema = z.array(conditionSchema).max(DEFINITION_LIMITS.conditionsPerRule)

export type Expression =
  | { kind: 'const'; value: number }
  | { kind: 'feature'; featureKey: string }
  | { kind: 'formula'; formulaKey: string }
  | { kind: 'lookup'; lookupKey: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/'; left: Expression; right: Expression }

export const expressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('const'), value: finiteNumber }).strict(),
    z.object({ kind: z.literal('feature'), featureKey: keySchema }).strict(),
    z.object({ kind: z.literal('formula'), formulaKey: keySchema }).strict(),
    z.object({ kind: z.literal('lookup'), lookupKey: keySchema }).strict(),
    z
      .object({
        kind: z.literal('op'),
        op: z.enum(['+', '-', '*', '/']),
        left: expressionSchema,
        right: expressionSchema,
      })
      .strict(),
  ]),
)

const featureOptionSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
    order: orderSchema,
    swatch: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
  })
  .strict()

export const featureSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1),
    type: z.enum(['choice', 'boolean', 'number', 'color']),
    options: z.array(featureOptionSchema).optional(),
    optionsFromLookup: keySchema.optional(),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
    step: finiteNumber.positive().optional(),
    unit: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    default: selectionValueSchema,
    order: orderSchema,
    inSummary: z.boolean(),
    visibleWhen: conditionListSchema.optional(),
  })
  .strict()
  .superRefine((feature, ctx) => {
    const isOptionType = feature.type === 'choice' || feature.type === 'color'
    if (isOptionType && !feature.options && !feature.optionsFromLookup) {
      ctx.addIssue({ code: 'custom', message: 'options_required', path: ['options'] })
    }
    if (!isOptionType && (feature.options || feature.optionsFromLookup)) {
      ctx.addIssue({ code: 'custom', message: 'options_not_allowed', path: ['options'] })
    }
    if (feature.type === 'color') {
      feature.options?.forEach((option, index) => {
        if (!option.swatch) {
          ctx.addIssue({ code: 'custom', message: 'swatch_required', path: ['options', index, 'swatch'] })
        }
      })
    }
    if (feature.type !== 'number' && (feature.min !== undefined || feature.max !== undefined || feature.step !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'bounds_not_allowed', path: ['min'] })
    }
    if (feature.min !== undefined && feature.max !== undefined && feature.min > feature.max) {
      ctx.addIssue({ code: 'custom', message: 'min_above_max', path: ['min'] })
    }
    const expectedDefaultType = feature.type === 'number' ? 'number' : feature.type === 'boolean' ? 'boolean' : 'string'
    if (typeof feature.default !== expectedDefaultType) {
      ctx.addIssue({ code: 'custom', message: 'default_type_mismatch', path: ['default'] })
    }
  })

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), featureKey: keySchema, value: selectionValueSchema }).strict(),
  z.object({ kind: z.literal('map'), featureKey: keySchema, from: z.record(z.string(), z.string()) }).strict(),
  z
    .object({ kind: z.literal('lookup_default'), featureKey: keySchema, lookupKey: keySchema, keyedBy: keySchema })
    .strict(),
])

export const ruleSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).optional(),
    effect: z.enum(['error', 'warning', 'force', 'surcharge']),
    when: conditionListSchema,
    action: actionSchema.optional(),
    messageTemplate: z.string(),
    featureKeys: z.array(keySchema),
    order: orderSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.effect === 'force' && !rule.action) {
      ctx.addIssue({ code: 'custom', message: 'action_required', path: ['action'] })
    }
    if (rule.effect !== 'force' && rule.action) {
      ctx.addIssue({ code: 'custom', message: 'action_not_allowed', path: ['action'] })
    }
  })

export const formulaSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1).optional(),
    expr: z
      .unknown()
      .superRefine((value, ctx) => {
        if (expressionDepth(value) > DEFINITION_LIMITS.expressionDepth) {
          ctx.addIssue({ code: 'custom', message: 'expression_too_deep', params: { limit: DEFINITION_LIMITS.expressionDepth } })
        }
      })
      .pipe(expressionSchema),
    unit: z.string().min(1).optional(),
    decimals: z.number().int().min(0).max(FORMULA_MAX_DECIMALS).optional(),
  })
  .strict()

const valueLookupSchema = z
  .object({
    kind: z.literal('value'),
    key: keySchema,
    label: z.string().min(1).optional(),
    keyedBy: keySchema,
    rows: z
      .array(z.object({ match: z.string(), value: z.union([z.string(), finiteNumber]) }).strict())
      .max(DEFINITION_LIMITS.lookupRows),
  })
  .strict()

const permittedLookupSchema = z
  .object({
    kind: z.literal('permitted'),
    key: keySchema,
    label: z.string().min(1).optional(),
    keyedBy: keySchema,
    rows: z
      .array(z.object({ match: z.string(), values: z.array(z.string()), default: z.string() }).strict())
      .max(DEFINITION_LIMITS.lookupRows),
  })
  .strict()

export const lookupSchema = z.discriminatedUnion('kind', [valueLookupSchema, permittedLookupSchema])

export const bomLineSchema = z
  .object({
    id: idSchema,
    sku: z.string().min(1).optional(),
    skuFromLookup: z.object({ lookupKey: keySchema, keyedBy: keySchema }).strict().optional(),
    uom: z.string().min(1),
    quantity: z.union([finiteNumber.nonnegative(), z.object({ formulaKey: keySchema }).strict()]),
    when: conditionListSchema,
    ruleId: idSchema.optional(),
    order: orderSchema,
  })
  .strict()
  .superRefine((line, ctx) => {
    if ((line.sku === undefined) === (line.skuFromLookup === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'sku_or_sku_from_lookup_required', path: ['sku'] })
    }
  })

export const commercialSchema = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    priceKindId: z.string().uuid(),
    allowPromotions: z.boolean().default(false),
    priceDisclaimer: z.string().optional(),
  })
  .strict()

const definitionObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    commercial: commercialSchema,
    fixedSpecification: z.array(z.object({ label: z.string().min(1), value: z.string() }).strict()),
    features: z.array(featureSchema).max(DEFINITION_LIMITS.features),
    rules: z.array(ruleSchema).max(DEFINITION_LIMITS.rules),
    formulas: z.array(formulaSchema).max(DEFINITION_LIMITS.formulas),
    lookups: z.array(lookupSchema).max(DEFINITION_LIMITS.lookups),
    bom: z.array(bomLineSchema).max(DEFINITION_LIMITS.bomLines),
  })
  .strict()

export const definitionSchema = z
  .unknown()
  .superRefine(maxJsonBytes(DEFINITION_LIMITS.definitionBytes))
  .pipe(definitionObjectSchema)

export const rawSelectionsSchema = z
  .record(z.string(), z.union([selectionValueSchema, z.null()]))
  .superRefine(maxJsonBytes(DEFINITION_LIMITS.evaluateRequestBytes))

export type ConfigurationDefinition = z.infer<typeof definitionSchema>
export type ConfigurationDefinitionInput = z.input<typeof definitionObjectSchema>
export type Feature = z.infer<typeof featureSchema>
export type FeatureType = Feature['type']
export type SelectionValue = z.infer<typeof selectionValueSchema>
export type Condition = z.infer<typeof conditionSchema>
export type Rule = z.infer<typeof ruleSchema>
export type RuleAction = z.infer<typeof actionSchema>
export type Formula = z.infer<typeof formulaSchema>
export type Lookup = z.infer<typeof lookupSchema>
export type ValueLookup = z.infer<typeof valueLookupSchema>
export type PermittedLookup = z.infer<typeof permittedLookupSchema>
export type BomLineDefinition = z.infer<typeof bomLineSchema>
export type RawSelections = z.infer<typeof rawSelectionsSchema>


export const MODEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const CATALOG_ITEMS_MAX_SKUS = 100

const draftDefinitionSchema = z.record(z.string(), z.unknown())

export const modelCreateSchema = z
  .object({
    productId: z.string().uuid(),
    modelKey: z.string().trim().min(1).max(100).regex(MODEL_KEY_PATTERN),
    title: z.string().trim().min(1).max(200),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    priceKindId: z.string().uuid(),
    draftDefinition: draftDefinitionSchema.optional(),
  })

export const modelUpdateSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    draftDefinition: draftDefinitionSchema.optional(),
  })
  .refine((input) => input.title !== undefined || input.draftDefinition !== undefined, {
    message: 'title_or_definition_required',
  })

export const modelIdSchema = z.object({ id: z.string().uuid() })

export const modelListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    id: z.string().uuid().optional(),
    search: z.string().optional(),
    productId: z.string().uuid().optional(),
    published: z.enum(['true', 'false']).optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
    sortField: z.enum(['title', 'modelKey', 'updatedAt']).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

export const modelVersionsQuerySchema = z
  .object({
    modelId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
  })
  .refine((query) => Boolean(query.modelId) !== Boolean(query.id), { message: 'model_id_or_id_required' })

export const catalogItemsQuerySchema = z.object({
  skus: z
    .string()
    .transform((value) => Array.from(new Set(value.split(',').map((sku) => sku.trim()).filter((sku) => sku.length > 0))))
    .pipe(z.array(z.string().max(255)).min(1)),
})

export type ModelCreateInput = z.infer<typeof modelCreateSchema>
export type ModelUpdateInput = z.infer<typeof modelUpdateSchema>
export type ModelIdInput = z.infer<typeof modelIdSchema>
export type ModelListQuery = z.infer<typeof modelListQuerySchema>

/** A date alone (`2026-10-27`) means the start of that day in UTC. */
export const previewContextSchema = z
  .object({
    channelId: z.string().uuid().nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
    date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable().optional(),
  })
  .strict()

export const modelPreviewSchema = z.object({
  id: z.string().uuid(),
  selections: rawSelectionsSchema.default({}),
  context: previewContextSchema.optional(),
})

export type PreviewContextInput = z.infer<typeof previewContextSchema>
export type ModelPreviewInput = z.infer<typeof modelPreviewSchema>

export const SESSION_STATUSES = ['open', 'finalising', 'finalised', 'cancelled'] as const
export const SESSION_IN_PROGRESS_STATUSES = ['open', 'finalising'] as const
export const SESSION_MODE_NEW = 'new'
export const SESSION_MODE_DUPLICATE = 'duplicate'

/**
 * `mode` is free text so the command can refuse modes it does not support with `mode_not_supported`.
 * `fromSnapshotId` without `mode` means `duplicate`.
 */
export const sessionOpenSchema = z.object({
  quoteId: z.string().uuid(),
  modelId: z.string().uuid().optional(),
  fromSnapshotId: z.string().uuid().optional(),
  mode: z.string().trim().min(1).max(50).optional(),
})

export const sessionEvaluateSchema = z.object({
  id: z.string().uuid(),
  selections: rawSelectionsSchema,
  revision: z.number().int().min(0),
})

export const sessionIdSchema = z.object({ id: z.string().uuid() })

export const sessionsQuerySchema = z
  .object({
    id: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
    status: z
      .string()
      .optional()
      .transform((value) => Array.from(new Set((value ?? '').split(',').map((status) => status.trim()).filter((status) => status.length > 0))))
      .pipe(z.array(z.enum(SESSION_STATUSES))),
  })
  .refine((query) => Boolean(query.id) !== Boolean(query.quoteId), { message: 'id_or_quote_id_required' })

export type SessionOpenInput = z.infer<typeof sessionOpenSchema>
export type SessionEvaluateInput = z.infer<typeof sessionEvaluateSchema>
export type SessionIdInput = z.infer<typeof sessionIdSchema>
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>

export const sessionFinaliseSchema = z.object({
  id: z.string().uuid(),
  expectedHash: z.string().trim().min(1).max(128),
  revision: z.number().int().min(0),
  migrationAcknowledged: z.boolean().optional(),
})

export const SNAPSHOTS_MAX_IDS = 100

/** One document per read: `quoteId`, `orderId` or `id` alone; `id` may be narrowed to an order with `orderId`. */
export const snapshotsQuerySchema = z
  .object({
    id: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
    orderId: z.string().uuid().optional(),
    ids: z
      .string()
      .optional()
      .transform((value) => Array.from(new Set((value ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0))))
      .pipe(z.array(z.string().uuid()).max(SNAPSHOTS_MAX_IDS)),
  })
  .refine((query) => [query.id && !query.orderId, query.quoteId, query.orderId].filter(Boolean).length === 1, {
    message: 'one_document_required',
  })

export const lineDiscountSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('percent'), value: z.number().finite().gt(0).max(100) }),
  z.object({ mode: z.literal('amount'), value: z.number().finite().gt(0).max(999_999_999_999) }),
])

/** Commercial fields of a configured quote line; its configured inputs are never editable here. */
export const lineUpdateSchema = z
  .object({
    quoteId: z.string().uuid(),
    lineId: z.string().uuid(),
    name: z.string().trim().min(1).max(255).optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
    discount: lineDiscountSchema.optional(),
    taxRateId: z.string().uuid().nullable().optional(),
  })
  .refine((input) => input.name !== undefined || input.comment !== undefined || input.discount !== undefined || input.taxRateId !== undefined, {
    message: 'nothing_to_update',
  })

export type LineDiscountInput = z.infer<typeof lineDiscountSchema>
export type LineUpdateInput = z.infer<typeof lineUpdateSchema>

export type SessionFinaliseInput = z.infer<typeof sessionFinaliseSchema>
export type SnapshotsQuery = z.infer<typeof snapshotsQuerySchema>
