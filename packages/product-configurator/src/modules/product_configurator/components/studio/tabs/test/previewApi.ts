import { z } from 'zod'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import {
  createIdsLookupSource,
  lookupLabelWithCode,
  pickLookupString,
  type LookupRemoteItem,
  type LookupSource,
} from '@open-mercato/ui/backend/inputs/lookupSources'
import {
  failureFromResponse,
  workspaceEvaluationSchema,
  type EvaluateOutcome,
  type WorkspaceSelections,
} from '../../../configurator/evaluationSchema'

export const PREVIEW_API = '/api/product_configurator/models/preview'

/** Who and when the draft is priced for; all empty is the reference context. */
export type PreviewContext = { channelId: string | null; customerId: string | null; date: string | null }

export const REFERENCE_CONTEXT: PreviewContext = { channelId: null, customerId: null, date: null }

export function isReferenceContext(context: PreviewContext): boolean {
  return !context.channelId && !context.customerId && !context.date
}

const firedRuleSchema = z.object({ ruleId: z.string(), label: z.string().nullable(), effect: z.enum(['error', 'warning', 'force', 'surcharge']) })
export type FiredRule = z.infer<typeof firedRuleSchema>

const previewResponseSchema = z.object({
  evaluation: workspaceEvaluationSchema,
  trace: z.object({ firedRules: z.array(firedRuleSchema) }),
  referenceContext: z.boolean(),
})

export type PreviewOutcome = EvaluateOutcome & { firedRules: FiredRule[] }

/** Read-only: the preview stores nothing, so it is a plain call like Validate, not a guarded mutation. */
export async function requestPreview(modelId: string, selections: WorkspaceSelections, context: PreviewContext): Promise<PreviewOutcome> {
  const body = {
    id: modelId,
    selections,
    ...(isReferenceContext(context) ? {} : { context }),
  }
  const call = await apiCall<unknown>(PREVIEW_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!call.ok) return { ok: false, failure: failureFromResponse(call.status, call.result), firedRules: [] }
  const parsed = previewResponseSchema.safeParse(call.result)
  if (!parsed.success) return { ok: false, failure: { kind: 'transient' }, firedRules: [] }
  return { ok: true, evaluation: parsed.data.evaluation, firedRules: parsed.data.trace.firedRules }
}

export const salesChannelSource = createIdsLookupSource('product-configurator-sales-channels', '/api/sales/channels', (item) => {
  const value = pickLookupString(item, 'id')
  if (!value) return null
  return { value, label: lookupLabelWithCode(pickLookupString(item, 'name') || value, pickLookupString(item, 'code')) }
})

function customerOption(item: LookupRemoteItem) {
  const value = pickLookupString(item, 'id')
  if (!value) return null
  return { value, label: pickLookupString(item, 'display_name', 'displayName') || value }
}

const companySource = createIdsLookupSource('product-configurator-companies', '/api/customers/companies', customerOption)
const personSource = createIdsLookupSource('product-configurator-people', '/api/customers/people', customerOption)

/** Quotes carry a customer entity, which is a company or a person, so both lists are searched. */
export const customerSource: LookupSource = {
  id: 'product-configurator-customers',
  search: async (query) => (await Promise.all([companySource.search(query), personSource.search(query)])).flat(),
  resolve: async (ids) => (await Promise.all([companySource.resolve(ids), personSource.resolve(ids)])).flat(),
}

/** The local calendar day of a picked date, sent as `YYYY-MM-DD`. */
export function toDateOnly(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function fromDateOnly(value: string | null): Date | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}
