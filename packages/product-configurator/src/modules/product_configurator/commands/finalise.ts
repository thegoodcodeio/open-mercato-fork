import type { EntityManager } from '@mikro-orm/postgresql'
import type { CatalogPriceRowService } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { CommandBus, CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { ConfigurationModel } from '../data/entities'
import { sessionFinaliseSchema, type SessionFinaliseInput } from '../data/validators'
import { emitProductConfiguratorEvent } from '../events'
import {
  FinaliseFailure,
  finaliseSession,
  type FinaliseDeps,
  type FinaliseFailureCode,
  type FinaliseObserver,
  type FinaliseResult,
  type FinaliseSession,
  type PreparedFinalise,
} from '../lib/finalise'
import { createFinaliseStore, createQuoteLock } from '../lib/finaliseStore'
import { markTrustedFinaliseRequest } from '../lib/lineGuard'
import { assertFeatures, FINALISE_FEATURES, findLineCarryingSnapshot, readQuoteHeader, tryResolve, type QuoteHeader } from '../lib/quoteAccess'
import { evaluateForQuote, findVersion, httpError, versionNotFound } from './sessions'
import { commandTenantId, resolveSessionScope, SESSION_RESOURCE_KIND, type ModelScope } from './shared'

const logger = createLogger('product_configurator.finalise')

/** The URL is never fetched; it only identifies the trusted request finalise hands to the sales command. */
const TRUSTED_REQUEST_URL = 'http://product-configurator.internal/finalise'

const FAILURES: Record<FinaliseFailureCode, { status: number; fallback: string }> = {
  session_not_found: { status: 404, fallback: 'Configuration session not found.' },
  session_not_open: { status: 409, fallback: 'This configuration was already added or discarded.' },
  finalise_in_progress: { status: 409, fallback: 'Another configuration is being added to this quote. Try again in a moment.' },
  finalise_busy: { status: 409, fallback: 'Adding is busy right now. Try again in a moment.' },
  session_changed: { status: 409, fallback: 'Someone else changed this configuration. Review the current choices.' },
  migration_unconfirmed: { status: 422, fallback: 'Review the changed choices before adding this configuration.' },
  not_finalisable: { status: 422, fallback: 'This configuration has errors and cannot be added to the quote.' },
  result_changed: { status: 409, fallback: 'The price changed. Review the new price and confirm.' },
  quote_changed: { status: 409, fallback: 'The quote was changed by someone else. Try again.' },
  quote_converted: { status: 409, fallback: 'The quote was converted or deleted, so this configuration cannot be added.' },
  quote_line_write_failed: { status: 502, fallback: 'The configuration could not be added to the quote. Try again.' },
}

export async function finaliseFailed(failure: FinaliseFailure): Promise<CrudHttpError> {
  const { status, fallback } = FAILURES[failure.code]
  return httpError(status, failure.code, fallback, failure.details)
}

function reportFailure(stage: string, error: unknown, context: Record<string, unknown>): void {
  logger.error(`Finalise ${stage} failed`, { ...context, err: error })
  getTelemetryRuntime()?.reportError(error, { module: 'product_configurator', code: `product_configurator.finalise_${stage}_failed` })
}

export const finaliseObserver: FinaliseObserver = {
  async snapshotCreated(payload) {
    try {
      await emitProductConfiguratorEvent('product_configurator.snapshot.created', payload, { persistent: true })
    } catch (error) {
      reportFailure('event', error, { snapshotId: payload.snapshotId, sessionId: payload.sessionId })
    }
  },
  failed: reportFailure,
  outcome(code, context) {
    logger.warn(`Finalise outcome: ${code}`, context)
  },
}

async function modelDeleted(): Promise<CrudHttpError> {
  return httpError(409, 'model_deleted', 'The configuration model was deleted, so this configuration cannot be added.')
}

async function productMissing(): Promise<CrudHttpError> {
  return httpError(422, 'product_missing', 'The catalog product of this configuration model no longer exists.')
}

/** Step 3: the model must be live, the bound product must exist, and the session is re-evaluated on current prices. */
async function prepareFinalise(
  em: EntityManager,
  ctx: CommandRuntimeContext,
  scope: ModelScope,
  session: FinaliseSession,
  quote: QuoteHeader,
): Promise<PreparedFinalise> {
  const version = await findVersion(em, session.modelVersionId, scope)
  if (!version) throw await versionNotFound()
  const model = await findOneWithDecryption(
    em,
    ConfigurationModel,
    { id: version.modelId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (!model || model.deletedAt) throw await modelDeleted()
  const rowService = tryResolve<CatalogPriceRowService>(ctx.container, 'catalogPriceRowService')
  if (!rowService) throw new Error('[internal] product_configurator: catalogPriceRowService is not registered')
  const product = (await rowService.resolveProducts(em, [model.productId], scope)).get(model.productId)
  if (!product) throw await productMissing()
  const result = await evaluateForQuote({ em, ctx, version, selections: session.selections, quote, scope })
  return { result, modelVersionHash: version.hash, modelTitle: model.title, productId: product.productId, taxRateId: product.taxRateId }
}

/**
 * The finalise ports over this command's context: the quote lock and module rows on the request's
 * EntityManager, sales reads through `queryEngine`, and the line write as a trusted
 * `sales.quotes.lines.upsert` that keeps auth and scope and replaces only the request.
 */
export function createFinaliseDeps(ctx: CommandRuntimeContext, scope: ModelScope): FinaliseDeps {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  return {
    lock: createQuoteLock(em),
    store: createFinaliseStore(em, scope),
    sales: {
      readQuote: (quoteId) => readQuoteHeader(ctx.container, quoteId, scope),
      async findLineCarrying(kind, parentId, snapshotId) {
        return (await findLineCarryingSnapshot(ctx.container, kind, parentId, snapshotId, scope))?.id ?? null
      },
      async writeLine(body, quoteUpdatedAt) {
        const headers = new Headers({ 'content-type': 'application/json' })
        if (quoteUpdatedAt) headers.set(OPTIMISTIC_LOCK_HEADER_NAME, quoteUpdatedAt)
        const request = markTrustedFinaliseRequest(new Request(TRUSTED_REQUEST_URL, { method: 'POST', headers }))
        const commandBus = ctx.container.resolve('commandBus') as CommandBus
        const { result } = await commandBus.execute<{ body: Record<string, unknown> }, { quoteId: string; lineId: string }>(
          'sales.quotes.lines.upsert',
          { input: { body }, ctx: { ...ctx, request } },
        )
        return result.lineId
      },
    },
    prepare: (session, quote) => prepareFinalise(em.fork(), ctx, scope, session, quote),
    observer: finaliseObserver,
  }
}

const finaliseSessionCommand: CommandHandler<SessionFinaliseInput, FinaliseResult> = {
  id: 'product_configurator.sessions.finalise',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = sessionFinaliseSchema.parse(rawInput)
    const scope = await resolveSessionScope(ctx)
    await assertFeatures(ctx, FINALISE_FEATURES, scope)
    try {
      return await finaliseSession(createFinaliseDeps(ctx, scope), input)
    } catch (error) {
      if (error instanceof FinaliseFailure) throw await finaliseFailed(error)
      throw error
    }
  },
  buildLog: async ({ input, result, ctx }) => {
    if (result.replay) return { skipLog: true }
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('product_configurator.audit.sessions.finalise', 'Add product configuration to quote'),
      resourceKind: SESSION_RESOURCE_KIND,
      resourceId: input.id,
      tenantId: commandTenantId(ctx),
      organizationId: ctx.selectedOrganizationId ?? null,
      snapshotAfter: {
        id: input.id,
        status: 'finalised',
        snapshotId: result.snapshotId,
        quoteLineId: result.quoteLineId,
        hash: result.hash,
        outcome: result.outcome,
      },
    }
  },
}

registerCommand(finaliseSessionCommand)

export { finaliseSessionCommand }
