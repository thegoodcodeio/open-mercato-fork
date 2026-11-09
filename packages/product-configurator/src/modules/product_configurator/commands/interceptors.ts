import type { EntityManager } from '@mikro-orm/postgresql'
import type {
  CommandInterceptor,
  CommandInterceptorBeforeResult,
  CommandInterceptorContext,
} from '@open-mercato/shared/lib/commands/command-interceptor'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSession, ConfigurationSnapshot } from '../data/entities'
import { SESSION_IN_PROGRESS_STATUSES } from '../data/validators'
import { reconcileConvertedQuote, type FinaliseDeps } from '../lib/finalise'
import { createFinaliseStore, createQuoteLock } from '../lib/finaliseStore'
import {
  bodyCarriesMarker,
  insertMatchesSnapshot,
  isTrustedFinaliseRequest,
  judgeLineWrite,
  type PendingSnapshotFacts,
} from '../lib/lineGuard'
import {
  findLineCarryingSnapshot,
  readQuoteHeader,
  readStoredLines,
  readStoredLinesInAnyTenant,
  type DocumentKind,
  type QuoteScope,
  type StoredLine,
} from '../lib/quoteAccess'
import { finaliseObserver } from './finalise'

const logger = createLogger('product_configurator.interceptors')

/** Runs after every other interceptor (lower priority runs earlier), so it judges the final input. */
const GUARD_PRIORITY = 1000

type Rejection = {
  code: 'configured_line_locked' | 'configured_line_forged' | 'configured_line_unverified'
  status: 403 | 409 | 422
  fields?: string[]
}

const REJECTION_FALLBACKS: Record<Rejection['code'], string> = {
  configured_line_locked:
    'This line was added by the product configurator. Its product, quantity, unit and net price cannot be changed here.',
  configured_line_forged: 'Configured lines can only be added by the product configurator.',
  configured_line_unverified: 'This line change was refused because the tenant is not known.',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function lineRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((line): line is Record<string, unknown> => line !== null) : []
}

async function reject(rejection: Rejection): Promise<CommandInterceptorBeforeResult> {
  let message = REJECTION_FALLBACKS[rejection.code]
  try {
    const { translate } = await resolveTranslations()
    message = translate(`product_configurator.errors.${rejection.code}`, message)
  } catch {
    message = REJECTION_FALLBACKS[rejection.code]
  }
  return {
    ok: false,
    status: rejection.status,
    message,
    body: { error: message, code: rejection.code, ...(rejection.fields ? { fields: rejection.fields } : {}) },
  }
}

/** The tenant from auth or the resolved organization scope; a tenant named in the body is never trusted. */
function trustedTenantId(context: CommandInterceptorContext): string | null {
  return context.auth?.tenantId ?? context.organizationScope?.tenantId ?? null
}

/** What a trusted configured insert must match: the pending snapshot, its session and the model's bound product. */
async function readPendingSnapshot(
  context: CommandInterceptorContext,
  snapshotId: string,
  scope: QuoteScope,
): Promise<PendingSnapshotFacts | null> {
  const em = (context.container.resolve('em') as EntityManager).fork()
  const where = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const snapshot = await findOneWithDecryption(em, ConfigurationSnapshot, { ...where, id: snapshotId }, undefined, scope)
  if (!snapshot) return null
  const session = await findOneWithDecryption(em, ConfigurationSession, { ...where, id: snapshot.sessionId }, undefined, scope)
  const version = await findOneWithDecryption(em, ConfigurationModelVersion, { ...where, id: snapshot.modelVersionId }, undefined, scope)
  const model = version
    ? await findOneWithDecryption(em, ConfigurationModel, { ...where, id: version.modelId }, undefined, scope)
    : null
  return {
    quoteId: snapshot.quoteId,
    quoteLineId: snapshot.quoteLineId ?? null,
    sessionStatus: session?.status ?? null,
    hash: snapshot.hash,
    netPrice: snapshot.netPrice,
    currencyCode: snapshot.currencyCode,
    productId: model?.productId ?? null,
  }
}

/**
 * The stored lines a write names. With a trusted tenant they are read in it; without one (a super
 * administrator without a tenant, a system dispatch) by id in any tenant, because sales then writes
 * the line of the quote it locks. Null when no tenant is known at all: the write cannot be judged.
 */
async function readNamedLines(
  kind: DocumentKind,
  ids: string[],
  context: CommandInterceptorContext,
  bodyTenantId: string | null,
): Promise<Map<string, StoredLine> | null> {
  if (!ids.length) return new Map()
  const tenantId = trustedTenantId(context)
  if (tenantId) return readStoredLines(context.container, kind, ids, tenantId)
  if (!bodyTenantId) return null
  return readStoredLinesInAnyTenant(context.container, kind, ids, bodyTenantId)
}

/**
 * Judges line writes of one document. Lines with an `id` are compared with the stored line read fresh
 * (a configured line keeps its marker and configured inputs); a marker on a plain line or on an insert
 * is forged unless it is a quote line insert on a request finalise created, matching its pending snapshot.
 */
async function guardLines(
  kind: DocumentKind,
  lines: Record<string, unknown>[],
  context: CommandInterceptorContext,
  options: { allowTrustedInsert: boolean; bodyTenantId: string | null },
): Promise<CommandInterceptorBeforeResult | void> {
  const ids = lines.map((line) => asString(line.id)).filter((id): id is string => id !== null)
  if (!ids.length && !lines.some(bodyCarriesMarker)) return
  const stored = await readNamedLines(kind, ids, context, options.bodyTenantId)
  if (!stored) return reject({ code: 'configured_line_unverified', status: 403 })
  const tenantId = trustedTenantId(context)
  const trusted = isTrustedFinaliseRequest(context.request)
  for (const line of lines) {
    const id = asString(line.id)
    const verdict = judgeLineWrite({ body: line, stored: id ? (stored.get(id) ?? null) : null, allowTrustedInsert: options.allowTrustedInsert, trusted })
    if (verdict.kind === 'allow') continue
    if (verdict.kind === 'locked') return reject({ code: 'configured_line_locked', status: 409, fields: verdict.fields })
    if (verdict.kind === 'forged') return reject({ code: 'configured_line_forged', status: 422 })
    const organizationId = context.selectedOrganizationId ?? asString(line.organizationId)
    const facts =
      verdict.snapshotId && tenantId && organizationId
        ? await readPendingSnapshot(context, verdict.snapshotId, { tenantId, organizationId })
        : null
    if (!insertMatchesSnapshot(line, verdict.hash, facts)) return reject({ code: 'configured_line_forged', status: 422 })
  }
}

function singleLineGuard(kind: DocumentKind, allowTrustedInsert: boolean): NonNullable<CommandInterceptor['beforeExecute']> {
  return async (input, context) => {
    const body = asRecord(asRecord(input)?.body)
    if (!body) return
    return guardLines(kind, [body], context, { allowTrustedInsert, bodyTenantId: asString(body.tenantId) })
  }
}

/**
 * After a conversion, reconcile the converted quote's sessions against the order (see
 * `reconcileConvertedQuote`). A conversion inside a caller's transaction (public accept) is not
 * committed yet when this runs, so a quote that is still readable means "not converted yet": nothing
 * is touched, and those sessions end on their next finalise (`quote_converted`) or discard.
 */
async function cleanUpConvertedQuote(input: unknown, result: unknown, context: CommandInterceptorContext): Promise<void> {
  const quoteId = asString(asRecord(input)?.quoteId)
  const orderId = asString(asRecord(result)?.orderId) ?? quoteId
  const tenantId = trustedTenantId(context)
  if (!quoteId || !orderId || !tenantId) return
  try {
    const em = (context.container.resolve('em') as EntityManager).fork()
    const sessions = await findWithDecryption(
      em,
      ConfigurationSession,
      { tenantId, quoteId, status: { $in: [...SESSION_IN_PROGRESS_STATUSES] } },
      { fields: ['id', 'organizationId'] },
      { tenantId, organizationId: null },
    )
    const organizationIds = Array.from(new Set(sessions.map((session) => session.organizationId)))
    for (const organizationId of organizationIds) {
      const scope = { tenantId, organizationId }
      if (await readQuoteHeader(context.container, quoteId, scope)) continue
      const deps: FinaliseDeps = {
        lock: createQuoteLock(em),
        store: createFinaliseStore(em, scope),
        sales: {
          readQuote: (id) => readQuoteHeader(context.container, id, scope),
          async findLineCarrying(kind, parentId, snapshotId) {
            return (await findLineCarryingSnapshot(context.container, kind, parentId, snapshotId, scope))?.id ?? null
          },
          writeLine: async () => {
            throw new Error('[internal] product_configurator: the conversion cleanup never writes lines')
          },
        },
        prepare: async () => {
          throw new Error('[internal] product_configurator: the conversion cleanup never re-evaluates')
        },
        observer: finaliseObserver,
      }
      const report = await reconcileConvertedQuote(deps, { quoteId, orderId })
      logger.info('Converted quote sessions reconciled', { quoteId, orderId, organizationId, ...report })
    }
  } catch (error) {
    logger.error('Converted quote cleanup failed', { quoteId, orderId, err: error })
    getTelemetryRuntime()?.reportError(error, { module: 'product_configurator', code: 'product_configurator.conversion_cleanup_failed' })
  }
}

export const interceptors: CommandInterceptor[] = [
  {
    id: 'product_configurator.configured-quote-line-guard',
    targetCommand: 'sales.quotes.lines.upsert',
    priority: GUARD_PRIORITY,
    beforeExecute: singleLineGuard('quote', true),
  },
  {
    id: 'product_configurator.configured-order-line-guard',
    targetCommand: 'sales.orders.lines.upsert',
    priority: GUARD_PRIORITY,
    beforeExecute: singleLineGuard('order', false),
  },
  {
    id: 'product_configurator.configured-order-lines-bulk-guard',
    targetCommand: 'sales.orders.lines.upsert_many',
    priority: GUARD_PRIORITY,
    async beforeExecute(input, context) {
      const body = asRecord(asRecord(input)?.body)
      if (!body) return
      return guardLines('order', lineRecords(body.lines), context, { allowTrustedInsert: false, bodyTenantId: asString(body.tenantId) })
    },
  },
  {
    id: 'product_configurator.configured-quote-create-guard',
    targetCommand: 'sales.quotes.create',
    priority: GUARD_PRIORITY,
    async beforeExecute(input) {
      if (lineRecords(asRecord(input)?.lines).some(bodyCarriesMarker)) return reject({ code: 'configured_line_forged', status: 422 })
    },
  },
  {
    id: 'product_configurator.configured-order-create-guard',
    targetCommand: 'sales.orders.create',
    priority: GUARD_PRIORITY,
    async beforeExecute(input) {
      if (lineRecords(asRecord(input)?.lines).some(bodyCarriesMarker)) return reject({ code: 'configured_line_forged', status: 422 })
    },
  },
  {
    id: 'product_configurator.converted-quote-cleanup',
    targetCommand: 'sales.quotes.convert_to_order',
    priority: GUARD_PRIORITY,
    afterExecute: async (input, result, context) => {
      await cleanUpConvertedQuote(input, result, context)
    },
  },
]

export default interceptors
