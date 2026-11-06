import { z } from 'zod'
import type { SelectionValue } from '../../data/validators'

const selectionValueSchema = z.union([z.string(), z.number(), z.boolean()])
const issueParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
const paramsSchema = z.record(z.string(), issueParamSchema)

const ruleIssueSchema = z.object({ ruleId: z.string(), params: paramsSchema })
const systemIssueSchema = z.object({ code: z.string(), params: paramsSchema })

/** The part of a priced evaluation (`ConfigurationResult`) the workspace renders. */
export const workspaceEvaluationSchema = z.object({
  selections: z.record(z.string(), selectionValueSchema),
  visibility: z.record(z.string(), z.boolean()),
  forced: z.array(z.object({ featureKey: z.string(), ruleId: z.string(), from: selectionValueSchema, to: selectionValueSchema })),
  availability: z.record(z.string(), z.object({ allowedValues: z.array(z.string()), reason: z.string().optional() })),
  errors: z.array(z.union([ruleIssueSchema, systemIssueSchema])),
  warnings: z.array(ruleIssueSchema),
  surcharges: z.array(z.object({ ruleId: z.string(), bomId: z.string(), params: paramsSchema })),
  finalisable: z.boolean(),
  bom: z.array(
    z.object({
      bomId: z.string(),
      sku: z.string(),
      label: z.string(),
      quantity: z.string(),
      uom: z.string(),
      unitPrice: z.string(),
      total: z.string(),
    }),
  ),
  netPrice: z.string(),
  currencyCode: z.string(),
  hash: z.string(),
})

export type WorkspaceEvaluation = z.infer<typeof workspaceEvaluationSchema>
export type WorkspaceIssue = WorkspaceEvaluation['errors'][number]
export type WorkspaceSelections = Record<string, SelectionValue>

const selectionIssueSchema = z.object({
  featureKey: z.string(),
  reason: z.string(),
  value: z.union([selectionValueSchema, z.null()]),
})

export const evaluationErrorBodySchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  params: paramsSchema.optional(),
  issues: z.array(selectionIssueSchema).optional(),
})

export type SelectionIssue = z.infer<typeof selectionIssueSchema>

/** Statuses of a configuration session (`ConfigurationSession.status`). */
export const SESSION_STATUSES = ['open', 'finalising', 'finalised', 'cancelled'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

const storedSelectionsSchema = z
  .record(z.string(), z.unknown())
  .transform((record) =>
    Object.fromEntries(Object.entries(record).filter((entry): entry is [string, SelectionValue] => selectionValueSchema.safeParse(entry[1]).success)),
  )

/** The current state of a session, as returned with 409 `session_changed`. */
export const sessionStateSchema = z.object({
  id: z.string(),
  status: z.enum(SESSION_STATUSES),
  revision: z.number().int(),
  selections: storedSelectionsSchema,
  evaluation: workspaceEvaluationSchema.nullable().catch(null),
})

export type SessionState = z.infer<typeof sessionStateSchema>

const MODEL_FIX_CODES = ['expression_error', 'fixed_point_not_reached', 'forced_value_invalid'] as const
export type ModelFixCode = (typeof MODEL_FIX_CODES)[number]

/**
 * How a failed evaluation is shown. Only `transient` (network, 5xx) offers Retry: the others fail the same
 * way again until the choices, the model or the catalog change.
 */
export type WorkspaceFailure =
  | { kind: 'selection'; issues: SelectionIssue[] }
  | { kind: 'price_missing'; skus: string[]; channelId: string | null }
  | { kind: 'model_fix'; code: ModelFixCode; params: Record<string, z.infer<typeof issueParamSchema>> }
  | { kind: 'transient' }
  | { kind: 'session_changed'; session: SessionState; rejected: WorkspaceSelections }
  | { kind: 'session_not_open'; status: SessionStatus | null }
  | { kind: 'other'; status: number; code: string | null; message: string | null }

export type EvaluateOutcome = { ok: true; evaluation: WorkspaceEvaluation } | { ok: false; failure: WorkspaceFailure }

function isModelFixCode(code: string | undefined): code is ModelFixCode {
  return MODEL_FIX_CODES.some((entry) => entry === code)
}

const sessionConflictBodySchema = z.object({
  code: z.string().optional(),
  session: sessionStateSchema.optional(),
  status: z.enum(SESSION_STATUSES).optional().catch(undefined),
})

/**
 * Maps a non-2xx evaluation response (session evaluate or model preview) to a workspace failure.
 * `sent` are the choices of the refused request, kept for a `session_changed` review.
 */
export function failureFromResponse(status: number, payload: unknown, sent: WorkspaceSelections = {}): WorkspaceFailure {
  if (status >= 500) return { kind: 'transient' }
  const parsed = evaluationErrorBodySchema.safeParse(payload)
  const body = parsed.success ? parsed.data : {}
  if (status === 409) {
    const conflict = sessionConflictBodySchema.safeParse(payload)
    const data = conflict.success ? conflict.data : {}
    if (data.code === 'session_changed' && data.session) return { kind: 'session_changed', session: data.session, rejected: sent }
    if (data.code === 'session_not_open') return { kind: 'session_not_open', status: data.status ?? null }
  }
  if (status === 422 && body.code === 'invalid_selection') return { kind: 'selection', issues: body.issues ?? [] }
  if (status === 422 && body.code === 'price_missing') {
    const skus = body.params?.skus
    const channelId = body.params?.channelId
    return {
      kind: 'price_missing',
      skus: Array.isArray(skus) ? skus : [],
      channelId: typeof channelId === 'string' ? channelId : null,
    }
  }
  if (status === 422 && isModelFixCode(body.code)) return { kind: 'model_fix', code: body.code, params: body.params ?? {} }
  return { kind: 'other', status, code: body.code ?? null, message: body.error ?? null }
}
