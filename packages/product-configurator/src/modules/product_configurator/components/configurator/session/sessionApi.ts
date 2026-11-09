import { z } from 'zod'
import { definitionSchema, type ConfigurationDefinition } from '../../../data/validators'
import { isOrganizationRequired } from '../../snapshots/snapshotsApi'
import {
  SESSION_STATUSES,
  failureFromResponse,
  sessionStateSchema,
  workspaceEvaluationSchema,
  type SessionState,
  type SessionStatus,
  type WorkspaceEvaluation,
  type WorkspaceFailure,
  type WorkspaceSelections,
} from '../evaluationSchema'

export const SESSIONS_API = '/api/product_configurator/sessions'
export const EVALUATE_API = `${SESSIONS_API}/evaluate`
export const CANCEL_API = `${SESSIONS_API}/cancel`
export const FINALISE_API = `${SESSIONS_API}/finalise`
export const SESSION_RESOURCE_KIND = 'product_configurator.session'
export const FINALISE_FEATURE = 'sales.quotes.manage'
export const ORDERS_VIEW_FEATURE = 'sales.orders.view'

export function configureHref(sessionId: string): string {
  return `/backend/product_configurator/configure/${encodeURIComponent(sessionId)}`
}

/** Query parameter that tells the quote tab which configured line to highlight and focus. */
export const HIGHLIGHT_PARAM = 'configuredLine'

export function quoteHref(quoteId: string, highlightSnapshotId?: string): string {
  const base = `/backend/sales/quotes/${encodeURIComponent(quoteId)}`
  return highlightSnapshotId ? `${base}?${HIGHLIGHT_PARAM}=${encodeURIComponent(highlightSnapshotId)}` : base
}

export const QUOTES_LIST_HREF = '/backend/sales/quotes'
export const ORDERS_LIST_HREF = '/backend/sales/orders'

export function orderHref(orderId: string): string {
  return `${ORDERS_LIST_HREF}/${encodeURIComponent(orderId)}`
}

/** Sales gives the order of a converted quote the quote id unless the caller chose another one. */
export function convertedOrderLookupUrl(quoteId: string): string {
  return `/api/sales/orders?id=${encodeURIComponent(quoteId)}&pageSize=1`
}

export type ConvertedQuoteLink = { kind: 'order'; href: string } | { kind: 'orders'; href: string } | { kind: 'quotes'; href: string }

const orderListSchema = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) })

/** The order of a converted quote when it is readable, else the orders list, else (no order access) the quotes list. */
export function convertedQuoteLinkFromResponse(status: number, payload: unknown, quoteId: string): ConvertedQuoteLink {
  const list = status === 200 ? orderListSchema.safeParse(payload) : null
  if (!list?.success) return { kind: 'quotes', href: QUOTES_LIST_HREF }
  if (list.data.items.some((item) => item.id === quoteId)) return { kind: 'order', href: orderHref(quoteId) }
  return { kind: 'orders', href: ORDERS_LIST_HREF }
}

/** A write that an injected mutation guard refused before it was sent; `message` is the guard's own text. */
export class MutationBlockedError extends Error {}

/**
 * Runs `operation` through a guarded mutation (`useGuardedMutation().runMutation`). A guard refusal rejects with
 * `MutationBlockedError`, so callers do not show it as a network failure; errors of the request itself pass through.
 */
export async function runGuardedCall<T>(run: (operation: () => Promise<T>) => Promise<T>, operation: () => Promise<T>): Promise<T> {
  let sent = false
  try {
    return await run(() => {
      sent = true
      return operation()
    })
  } catch (error) {
    if (sent) throw error
    throw new MutationBlockedError(error instanceof Error ? error.message : '')
  }
}

const selectionsSchema = sessionStateSchema.shape.selections

const sessionDetailSchema = z.object({
  id: z.string(),
  status: z.enum(SESSION_STATUSES),
  revision: z.number().int(),
  quoteId: z.string(),
  quote: z
    .object({ id: z.string(), number: z.string().nullable(), customerName: z.string().nullable(), currencyCode: z.string() })
    .nullable(),
  modelVersion: z.object({
    id: z.string(),
    version: z.number().int().nullable(),
    modelTitle: z.string().nullable(),
    definition: z.unknown(),
  }),
  selections: selectionsSchema,
  evaluation: workspaceEvaluationSchema.nullable().catch(null),
})

export type SessionDetail = Omit<z.infer<typeof sessionDetailSchema>, 'modelVersion'> & {
  modelVersion: { id: string; version: number | null; modelTitle: string | null; definition: ConfigurationDefinition }
}

export type SessionLoad =
  | { status: 'ready'; session: SessionDetail }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'organization_required' }
  | { status: 'error' }

/** Reads `GET /sessions?id=`; a definition that does not parse is an error, never an empty workspace. */
export function sessionLoadFromResponse(status: number, payload: unknown): SessionLoad {
  if (status === 404) return { status: 'not_found' }
  if (status === 403) return { status: 'forbidden' }
  if (isOrganizationRequired(status, payload)) return { status: 'organization_required' }
  if (status !== 200) return { status: 'error' }
  const parsed = sessionDetailSchema.safeParse(payload)
  if (!parsed.success) return { status: 'error' }
  const definition = definitionSchema.safeParse(parsed.data.modelVersion.definition)
  if (!definition.success) return { status: 'error' }
  return { status: 'ready', session: { ...parsed.data, modelVersion: { ...parsed.data.modelVersion, definition: definition.data } } }
}

const evaluateResponseSchema = z.object({ revision: z.number().int(), evaluation: workspaceEvaluationSchema })

export type SessionEvaluateOutcome =
  | { ok: true; revision: number; evaluation: WorkspaceEvaluation }
  | { ok: false; failure: WorkspaceFailure }

export function evaluateOutcomeFromResponse(status: number, payload: unknown, sent: WorkspaceSelections): SessionEvaluateOutcome {
  if (status !== 200) return { ok: false, failure: failureFromResponse(status, payload, sent) }
  const parsed = evaluateResponseSchema.safeParse(payload)
  if (!parsed.success) return { ok: false, failure: { kind: 'transient' } }
  return { ok: true, revision: parsed.data.revision, evaluation: parsed.data.evaluation }
}

/** Why a configuration cannot be added at all; Discard is the way out. */
export const CANNOT_ADD_CODES = ['model_deleted', 'product_missing', 'currency_mismatch'] as const
export type CannotAddCode = (typeof CANNOT_ADD_CODES)[number]

/** What the rep sees after "Add to quote" (spec UI/UX "Outcomes"). */
export type FinaliseOutcome =
  | { kind: 'added'; snapshotId: string; quoteLineId: string; replay: boolean }
  | { kind: 'added_with_earlier_choices'; snapshotId: string }
  | { kind: 'result_changed'; result: WorkspaceEvaluation }
  | { kind: 'session_changed'; session: SessionState }
  | { kind: 'session_not_open'; status: SessionStatus | null }
  | { kind: 'in_progress' }
  | { kind: 'busy' }
  | { kind: 'quote_changed' }
  | { kind: 'quote_converted' }
  | { kind: 'cannot_add'; code: CannotAddCode }
  | { kind: 'write_failed'; status: SessionStatus | null }
  | { kind: 'not_finalisable'; result: WorkspaceEvaluation | null }
  | { kind: 'evaluation'; failure: WorkspaceFailure }
  | { kind: 'transient' }
  | { kind: 'other'; message: string | null }

/** A refused or unfinished "Add to quote" shown in the summary; `added` navigates away and `session_changed` opens the review. */
export type PanelOutcome = Exclude<FinaliseOutcome, { kind: 'added' } | { kind: 'session_changed' }>

const finaliseSuccessSchema = z.object({
  snapshotId: z.string(),
  quoteLineId: z.string(),
  hash: z.string(),
  replay: z.boolean(),
  outcome: z.enum(['added', 'added_with_earlier_choices']).optional(),
})

const finaliseErrorSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  result: workspaceEvaluationSchema.optional().catch(undefined),
  session: sessionStateSchema.optional().catch(undefined),
  status: z.enum(SESSION_STATUSES).optional().catch(undefined),
})

const EVALUATION_CODES = ['invalid_selection', 'price_missing', 'expression_error', 'fixed_point_not_reached', 'forced_value_invalid']

function isCannotAddCode(code: string | undefined): code is CannotAddCode {
  return CANNOT_ADD_CODES.some((entry) => entry === code)
}

export function finaliseOutcomeFromResponse(status: number, payload: unknown): FinaliseOutcome {
  if (status === 200) {
    const parsed = finaliseSuccessSchema.safeParse(payload)
    if (!parsed.success) return { kind: 'transient' }
    if (parsed.data.outcome === 'added_with_earlier_choices') return { kind: 'added_with_earlier_choices', snapshotId: parsed.data.snapshotId }
    return { kind: 'added', snapshotId: parsed.data.snapshotId, quoteLineId: parsed.data.quoteLineId, replay: parsed.data.replay }
  }
  if (status >= 500 && status !== 502) return { kind: 'transient' }
  const parsed = finaliseErrorSchema.safeParse(payload)
  const body = parsed.success ? parsed.data : {}
  switch (body.code) {
    case 'result_changed':
      return body.result ? { kind: 'result_changed', result: body.result } : { kind: 'other', message: body.error ?? null }
    case 'session_changed':
      return body.session ? { kind: 'session_changed', session: body.session } : { kind: 'other', message: body.error ?? null }
    case 'session_not_open':
      return { kind: 'session_not_open', status: body.status ?? null }
    case 'finalise_in_progress':
      return { kind: 'in_progress' }
    case 'finalise_busy':
      return { kind: 'busy' }
    case 'quote_changed':
      return { kind: 'quote_changed' }
    case 'quote_converted':
      return { kind: 'quote_converted' }
    case 'quote_line_write_failed':
      return { kind: 'write_failed', status: body.status ?? null }
    case 'not_finalisable':
      return { kind: 'not_finalisable', result: body.result ?? null }
  }
  if (isCannotAddCode(body.code)) return { kind: 'cannot_add', code: body.code }
  if (body.code && EVALUATION_CODES.includes(body.code)) return { kind: 'evaluation', failure: failureFromResponse(status, payload) }
  if (status === 502) return { kind: 'write_failed', status: null }
  return { kind: 'other', message: body.error ?? null }
}

/**
 * Fields whose value differs between what the rep sees with the refused choices applied (`rejected`
 * over the settled values the rep last saw) and the current session state.
 */
export function changedChoices(
  definition: ConfigurationDefinition,
  conflict: { rejected: WorkspaceSelections; shown: WorkspaceSelections; session: SessionState },
): Array<{ featureKey: string; label: string; yours: WorkspaceSelections[string] | null; current: WorkspaceSelections[string] | null }> {
  const currentSettled = conflict.session.evaluation?.selections ?? {}
  return definition.features.flatMap((feature) => {
    const yours = conflict.rejected[feature.key] ?? conflict.shown[feature.key] ?? null
    const current = conflict.session.selections[feature.key] ?? currentSettled[feature.key] ?? null
    if (yours === current) return []
    return [{ featureKey: feature.key, label: feature.label, yours, current }]
  })
}
