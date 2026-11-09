import { z } from 'zod'
import { MODELS_API_URL } from '../models/modelsApi'
import { SESSION_STATUSES } from '../configurator/evaluationSchema'
import { SESSIONS_API } from '../configurator/session/sessionApi'
import { isOrganizationRequired } from '../snapshots/snapshotsApi'

export const SESSIONS_MANAGE_FEATURE = 'product_configurator.sessions.manage'
export const MODELS_VIEW_FEATURE = 'product_configurator.models.view'

/** The context the sales document page passes to `sales.document.detail.quote:tabs` widgets. */
export const quoteTabContextSchema = z.object({
  kind: z.string(),
  documentId: z.string().nullable().optional(),
  record: z.object({ id: z.string(), currencyCode: z.string().nullable().optional() }).passthrough().nullable().optional(),
})

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  latestVersion: z.object({ id: z.string(), version: z.number().int() }).nullable(),
})

export type ModelCandidate = z.infer<typeof candidateSchema>

const candidateListSchema = z.object({ items: z.array(candidateSchema) })

/** Models a quote can be configured with: published, in the quote currency, in the selected organization. */
export function candidatesUrl(currencyCode: string): string {
  const params = new URLSearchParams({ published: 'true', currencyCode, pageSize: '100', sortField: 'title', sortDir: 'asc' })
  return `${MODELS_API_URL}?${params.toString()}`
}

export function parseCandidates(payload: unknown): ModelCandidate[] | null {
  const parsed = candidateListSchema.safeParse(payload)
  if (!parsed.success) return null
  return parsed.data.items.filter((item) => item.latestVersion !== null)
}

const sessionItemSchema = z.object({
  id: z.string(),
  status: z.enum(SESSION_STATUSES),
  modelVersion: z.object({ version: z.number().int().nullable(), modelTitle: z.string().nullable() }),
  createdBy: z.object({ id: z.string(), displayName: z.string().nullable() }).nullable(),
  createdAt: z.string(),
})

export type SessionListItem = z.infer<typeof sessionItemSchema>

export function sessionsUrl(quoteId: string): string {
  return `${SESSIONS_API}?quoteId=${encodeURIComponent(quoteId)}`
}

export function parseSessions(payload: unknown): SessionListItem[] | null {
  const parsed = z.object({ items: z.array(sessionItemSchema) }).safeParse(payload)
  return parsed.success ? parsed.data.items : null
}

/** What happened when "Configure product" opened a session. */
export type OpenOutcome =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'model_required' }
  | { kind: 'not_offered' }
  | { kind: 'organization_required' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string | null }

const openBodySchema = z.object({ sessionId: z.string().optional(), code: z.string().optional(), error: z.string().optional() })

export function openOutcomeFromResponse(status: number, payload: unknown): OpenOutcome {
  const parsed = openBodySchema.safeParse(payload)
  const body = parsed.success ? parsed.data : {}
  if (status === 201 && body.sessionId) return { kind: 'opened', sessionId: body.sessionId }
  if (status === 403) return { kind: 'forbidden' }
  if (isOrganizationRequired(status, payload)) return { kind: 'organization_required' }
  if (body.code === 'model_required') return { kind: 'model_required' }
  if (body.code === 'no_published_version' || body.code === 'currency_mismatch' || body.code === 'model_not_found') return { kind: 'not_offered' }
  return { kind: 'error', message: body.error ?? null }
}
