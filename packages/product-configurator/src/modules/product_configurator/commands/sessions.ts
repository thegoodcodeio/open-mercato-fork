import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { z } from 'zod'
import {
  ConfigurationModel,
  ConfigurationModelVersion,
  ConfigurationSession,
  type ConfigurationSessionStatus,
} from '../data/entities'
import {
  definitionSchema,
  rawSelectionsSchema,
  SESSION_MODE_NEW,
  sessionEvaluateSchema,
  sessionIdSchema,
  sessionOpenSchema,
  type ConfigurationDefinition,
  type RawSelections,
  type SessionEvaluateInput,
  type SessionIdInput,
  type SessionOpenInput,
} from '../data/validators'
import { evaluateConfiguration, type ConfigurationResult } from '../lib/evaluation'
import { ConfiguratorEvaluationError } from '../lib/evaluator/errors'
import { assertFeatures, readQuoteHeader, SESSION_FEATURES, type QuoteHeader } from '../lib/quoteAccess'
import {
  commandTenantId,
  findLiveModel,
  findSession,
  modelNotFound,
  quoteNotFound,
  resolveSessionScope,
  sessionNotFound,
  SESSION_RESOURCE_KIND,
  type ModelScope,
} from './shared'

const MAX_MODEL_CANDIDATES = 100

export type SessionModelVersionRef = { id: string; version: number; hash: string; modelId: string; modelTitle: string }

export type SessionOpenResult = {
  sessionId: string
  revision: number
  modelVersion: SessionModelVersionRef
  quote: { id: string; number: string | null; customerName: string | null }
}

/** The part of a session a client needs to continue from the current revision. */
export type SessionState = {
  id: string
  status: ConfigurationSessionStatus
  revision: number
  selections: Record<string, unknown>
  evaluation: Record<string, unknown> | null
}

export type SessionEvaluateResult = SessionState & { evaluation: ConfigurationResult }

export type SessionCancelResult = { id: string; status: ConfigurationSessionStatus }

function resolveEm(ctx: CommandRuntimeContext): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

export function toSessionState(session: ConfigurationSession): SessionState {
  return {
    id: session.id,
    status: session.status,
    revision: session.revision,
    selections: session.selections,
    evaluation: session.evaluation ?? null,
  }
}

export async function httpError(status: number, code: string, fallback: string, extra: Record<string, unknown> = {}): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(status, { error: translate(`product_configurator.errors.${code}`, fallback), code, ...extra })
}

const modeNotSupported = () => httpError(400, 'mode_not_supported', 'This configuration mode is not supported.')
export const currencyMismatch = (model: string, quote: string) =>
  httpError(409, 'currency_mismatch', 'The model currency does not match the quote currency.', {
    params: { modelCurrency: model, quoteCurrency: quote },
  })
const noPublishedVersion = () => httpError(409, 'no_published_version', 'No published configuration model fits this quote.')
const modelRequired = (candidateIds: string[]) =>
  httpError(409, 'model_required', 'Several configuration models fit this quote. Choose one.', { candidateIds })
const sessionNotOpen = (status: ConfigurationSessionStatus) =>
  httpError(409, 'session_not_open', 'This configuration was already added or discarded.', { status })
const sessionChanged = (session: ConfigurationSession) =>
  httpError(409, 'session_changed', 'Someone else changed this configuration. Review the current choices.', {
    session: toSessionState(session),
  })
export const versionNotFound = () => httpError(404, 'version_not_found', 'Model version not found.')

const EVALUATION_FALLBACKS: Record<ConfiguratorEvaluationError['code'], string> = {
  invalid_selection: 'One of the choices is not valid.',
  fixed_point_not_reached: 'This model needs a fix by an admin: its rules do not settle.',
  forced_value_invalid: 'This model needs a fix by an admin: a rule sets a value that is not allowed.',
  expression_error: 'This model needs a fix by an admin: a formula cannot be computed.',
  price_missing: 'A part has no catalog price for this quote.',
}

/** Typed evaluation failures become 422 with their code, params and per-field issues; nothing is stored. */
export async function evaluationFailed(error: ConfiguratorEvaluationError): Promise<CrudHttpError> {
  return httpError(422, error.code, EVALUATION_FALLBACKS[error.code], { params: error.params, issues: error.issues })
}

export async function findVersion(em: EntityManager, id: string, scope: ModelScope): Promise<ConfigurationModelVersion | null> {
  return findOneWithDecryption(
    em,
    ConfigurationModelVersion,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
}

/**
 * Candidates are the live models of the organization with a published version in the quote currency.
 * One candidate is opened directly; several need an explicit `modelId`.
 */
async function pickModel(em: EntityManager, input: SessionOpenInput, quote: QuoteHeader, scope: ModelScope): Promise<ConfigurationModel> {
  if (input.modelId) {
    const model = await findLiveModel(em, input.modelId, scope)
    if (!model) throw await modelNotFound()
    if (!model.latestVersionId) throw await noPublishedVersion()
    if (model.currencyCode !== quote.currencyCode) throw await currencyMismatch(model.currencyCode, quote.currencyCode)
    return model
  }
  const candidates = await findWithDecryption(
    em,
    ConfigurationModel,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      currencyCode: quote.currencyCode,
      latestVersionId: { $ne: null },
    },
    { orderBy: { title: 'asc', id: 'asc' }, limit: MAX_MODEL_CANDIDATES },
    scope,
  )
  if (candidates.length === 0) throw await noPublishedVersion()
  if (candidates.length > 1) throw await modelRequired(candidates.map((model) => model.id))
  return candidates[0]
}

const openSessionCommand: CommandHandler<SessionOpenInput, SessionOpenResult> = {
  id: 'product_configurator.sessions.open',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = sessionOpenSchema.parse(rawInput)
    const scope = await resolveSessionScope(ctx)
    const userId = await assertFeatures(ctx, SESSION_FEATURES, scope)
    if (input.fromSnapshotId || (input.mode !== undefined && input.mode !== SESSION_MODE_NEW)) throw await modeNotSupported()

    const quote = await readQuoteHeader(ctx.container, input.quoteId, scope)
    if (!quote) throw await quoteNotFound()
    const em = resolveEm(ctx)
    const model = await pickModel(em, input, quote, scope)
    const version = model.latestVersionId ? await findVersion(em, model.latestVersionId, scope) : null
    if (!version) throw await noPublishedVersion()

    const session = em.create(ConfigurationSession, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      modelVersionId: version.id,
      quoteId: quote.id,
      selections: {},
      evaluation: null,
      revision: 0,
      mode: SESSION_MODE_NEW,
      migration: null,
      status: 'open',
      createdBy: z.string().uuid().safeParse(userId).success ? userId : null,
    })
    em.persist(session)
    await em.flush()
    return {
      sessionId: session.id,
      revision: session.revision,
      modelVersion: { id: version.id, version: version.version, hash: version.hash, modelId: model.id, modelTitle: model.title },
      quote: { id: quote.id, number: quote.quoteNumber, customerName: quote.customerName },
    }
  },
  buildLog: async ({ result, ctx }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('product_configurator.audit.sessions.open', 'Start product configuration'),
      resourceKind: SESSION_RESOURCE_KIND,
      resourceId: result.sessionId,
      tenantId: commandTenantId(ctx),
      organizationId: ctx.selectedOrganizationId ?? null,
      snapshotAfter: {
        id: result.sessionId,
        quoteId: result.quote.id,
        modelVersionId: result.modelVersion.id,
        status: 'open',
        mode: SESSION_MODE_NEW,
      },
    }
  },
}

/** User intent only: explicit nulls clear a choice, so they are not stored. */
function intentOf(selections: RawSelections): Record<string, unknown> {
  return Object.fromEntries(Object.entries(selections).filter(([, value]) => value !== null))
}

/** The revision counts changes of the intent, so re-evaluating the stored choices (opening a session) never makes another window stale. */
function sameIntent(stored: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = Object.keys(next)
  return keys.length === Object.keys(stored).length && keys.every((key) => Object.is(stored[key], next[key]))
}

/**
 * Prices `selections` on `version` for the quote's channel and customer. A version whose currency no
 * longer matches the quote answers 409 `currency_mismatch`; typed evaluation failures answer 422.
 */
export async function evaluateForQuote(input: {
  em: EntityManager
  ctx: CommandRuntimeContext
  version: ConfigurationModelVersion
  selections: RawSelections | Record<string, unknown>
  quote: QuoteHeader
  scope: ModelScope
}): Promise<ConfigurationResult> {
  const { em, ctx, version, quote, scope } = input
  const definition: ConfigurationDefinition = definitionSchema.parse(version.definition)
  if (definition.commercial.currencyCode !== quote.currencyCode) {
    throw await currencyMismatch(definition.commercial.currencyCode, quote.currencyCode)
  }
  try {
    return await evaluateConfiguration({
      definition,
      modelVersion: { id: version.id, hash: version.hash },
      selections: rawSelectionsSchema.parse(input.selections),
      pricing: {
        em,
        container: ctx.container,
        scope,
        channelId: quote.channelId,
        customerId: quote.customerEntityId,
        at: new Date(),
      },
    })
  } catch (error) {
    if (error instanceof ConfiguratorEvaluationError) throw await evaluationFailed(error)
    throw error
  }
}

async function evaluateSession(
  em: EntityManager,
  ctx: CommandRuntimeContext,
  session: ConfigurationSession,
  selections: RawSelections,
  scope: ModelScope,
): Promise<ConfigurationResult> {
  const quote = await readQuoteHeader(ctx.container, session.quoteId, scope)
  if (!quote) throw await quoteNotFound()
  const version = await findVersion(em, session.modelVersionId, scope)
  if (!version) throw await versionNotFound()
  return evaluateForQuote({ em, ctx, version, selections, quote, scope })
}

const evaluateSessionCommand: CommandHandler<SessionEvaluateInput, SessionEvaluateResult> = {
  id: 'product_configurator.sessions.evaluate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = sessionEvaluateSchema.parse(rawInput)
    const scope = await resolveSessionScope(ctx)
    await assertFeatures(ctx, SESSION_FEATURES, scope)
    const em = resolveEm(ctx)
    const session = await findSession(em, input.id, scope)
    if (!session) throw await sessionNotFound()
    if (session.status !== 'open') throw await sessionNotOpen(session.status)
    if (session.revision !== input.revision) throw await sessionChanged(session)

    const evaluation = await evaluateSession(em, ctx, session, input.selections, scope)
    const selections = intentOf(input.selections)
    const stored = await em.transactional(async (trx) => {
      const locked = await findSession(trx, input.id, scope, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
      if (!locked) throw await sessionNotFound()
      if (locked.status !== 'open') throw await sessionNotOpen(locked.status)
      if (locked.revision !== input.revision) throw await sessionChanged(locked)
      if (!sameIntent(locked.selections, selections)) locked.revision = input.revision + 1
      locked.selections = selections
      locked.evaluation = evaluation
      await trx.flush()
      return locked
    })
    return { ...toSessionState(stored), evaluation }
  },
}

const cancelSessionCommand: CommandHandler<SessionIdInput, SessionCancelResult> = {
  id: 'product_configurator.sessions.cancel',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = sessionIdSchema.parse(rawInput)
    const scope = await resolveSessionScope(ctx)
    await assertFeatures(ctx, SESSION_FEATURES, scope)
    const em = resolveEm(ctx)
    return em.transactional(async (trx) => {
      const locked = await findSession(trx, input.id, scope, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
      if (!locked) throw await sessionNotFound()
      if (locked.status !== 'open') throw await sessionNotOpen(locked.status)
      locked.status = 'cancelled'
      await trx.flush()
      return { id: locked.id, status: locked.status }
    })
  },
  buildLog: async ({ result, ctx }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('product_configurator.audit.sessions.cancel', 'Discard product configuration'),
      resourceKind: SESSION_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: commandTenantId(ctx),
      organizationId: ctx.selectedOrganizationId ?? null,
      snapshotBefore: { id: result.id, status: 'open' },
      snapshotAfter: { id: result.id, status: result.status },
    }
  },
}

registerCommand(openSessionCommand)
registerCommand(evaluateSessionCommand)
registerCommand(cancelSessionCommand)

export { openSessionCommand, evaluateSessionCommand, cancelSessionCommand }
