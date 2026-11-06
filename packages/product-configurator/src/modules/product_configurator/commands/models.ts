import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { emitCrudSideEffects, emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { makeCreateRedo } from '@open-mercato/shared/lib/commands/redo'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import {
  enforceCommandOptimisticLockWithGuards,
  enforceRecordGoneIsConflict,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { ConfigurationModel, ConfigurationModelVersion } from '../data/entities'
import {
  definitionSchema,
  modelCreateSchema,
  modelIdSchema,
  modelUpdateSchema,
  type ModelCreateInput,
  type ModelIdInput,
  type ModelUpdateInput,
} from '../data/validators'
import { emitProductConfiguratorEvent } from '../events'
import { hashDefinition } from '../lib/hash'
import { buildEmptyDefinition, computeDraftHash, findDraftProblem, type DraftDefinition } from '../lib/modelDraft'
import { validateModelDraft } from '../lib/modelValidation'
import {
  MODEL_RESOURCE_KIND,
  commandTenantId,
  findLiveModel,
  modelCrudEvents,
  modelCrudIndexer,
  modelNotFound,
  resolveModelScope,
  resolveReplayScope,
  toModelAuditSnapshot,
  type ModelAuditSnapshot,
  type ModelScope,
} from './shared'

const logger = createLogger('product_configurator.models')

export const MODEL_KEY_UNIQUE_INDEX = 'product_configurator_models_model_key_unique'

type ModelCreateSnapshot = ModelAuditSnapshot & { draftDefinition: DraftDefinition }
type ModelDraftSnapshot = Pick<ModelAuditSnapshot, 'id' | 'tenantId' | 'organizationId' | 'title' | 'draftHash'> & {
  draftDefinition: DraftDefinition
}
type ModelCreateUndoPayload = { after?: ModelCreateSnapshot | null }
type ModelUpdateUndoPayload = { before?: ModelDraftSnapshot | null }
type ModelDeleteUndoPayload = { before?: ModelAuditSnapshot | null }

export type ModelPublishResult = { modelVersionId: string; version: number; hash: string; updatedAt: string }

function resolveEm(ctx: CommandRuntimeContext): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

function resolveDataEngine(ctx: CommandRuntimeContext): DataEngine {
  return ctx.container.resolve('dataEngine') as DataEngine
}

function modelIdentifiers(model: ConfigurationModel) {
  return { id: model.id, tenantId: model.tenantId, organizationId: model.organizationId }
}

async function duplicateModelKey(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(409, {
    error: translate('product_configurator.errors.duplicate_model_key', 'A configuration model with this key already exists.'),
    code: 'duplicate_model_key',
  })
}

async function invalidDefinition(reason: string): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(400, {
    error: translate('product_configurator.errors.invalid_definition', 'The model definition cannot be saved.'),
    code: 'invalid_definition',
    reason,
  })
}

async function assertDraftAccepted(draft: DraftDefinition, currencyCode: string): Promise<void> {
  const problem = findDraftProblem(draft, currencyCode)
  if (problem) throw await invalidDefinition(problem)
}

function readCommercialPriceKind(draft: DraftDefinition): unknown {
  const commercial = draft.commercial
  if (!commercial || typeof commercial !== 'object' || Array.isArray(commercial)) return undefined
  return (commercial as Record<string, unknown>).priceKindId
}

async function assertModelVersion(model: ConfigurationModel | null, id: string, ctx: CommandRuntimeContext) {
  if (!model) {
    enforceRecordGoneIsConflict({ resourceKind: MODEL_RESOURCE_KIND, resourceId: id, request: ctx.request ?? null })
    throw await modelNotFound()
  }
  await enforceCommandOptimisticLockWithGuards(ctx.container, {
    resourceKind: MODEL_RESOURCE_KIND,
    resourceId: model.id,
    current: model.updatedAt,
    request: ctx.request ?? null,
  })
  return model
}

async function loadModelInScope(em: EntityManager, id: string, scope: ModelScope, ctx: CommandRuntimeContext) {
  return assertModelVersion(await findLiveModel(em, id, scope), id, ctx)
}

/**
 * Row-locks the model, checks the optimistic-lock token against the locked row, takes the undo
 * snapshot (`beforeTransactionalWrite`) and applies `mutate`, all in one transaction, so two
 * writers holding the same token cannot both pass the check.
 */
async function writeLockedModel(
  em: EntityManager,
  input: { id: string },
  scope: ModelScope,
  ctx: CommandRuntimeContext,
  label: string,
  mutate: (model: ConfigurationModel) => Promise<void> | void,
): Promise<ConfigurationModel> {
  const written: { model: ConfigurationModel | null } = { model: null }
  await withAtomicFlush(
    em,
    [
      async () => {
        const locked = await findLiveModel(em, input.id, scope, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
        const model = await assertModelVersion(locked, input.id, ctx)
        await ctx.beforeTransactionalWrite?.(em, input)
        await mutate(model)
        written.model = model
      },
    ],
    { transaction: true, label },
  )
  if (!written.model) throw await modelNotFound()
  return written.model
}

async function findModelForReplay(em: EntityManager, id: string, scope: ModelScope) {
  return findOneWithDecryption(
    em,
    ConfigurationModel,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
}

function withoutDraft(snapshot: ModelCreateSnapshot): ModelAuditSnapshot {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    productId: snapshot.productId,
    modelKey: snapshot.modelKey,
    title: snapshot.title,
    currencyCode: snapshot.currencyCode,
    draftHash: snapshot.draftHash,
    latestVersionId: snapshot.latestVersionId,
  }
}

const createModelCommand: CommandHandler<ModelCreateInput, { id: string }> = {
  id: 'product_configurator.models.create',
  async execute(rawInput, ctx) {
    const input = modelCreateSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const draft: DraftDefinition = input.draftDefinition ?? buildEmptyDefinition(input)
    await assertDraftAccepted(draft, input.currencyCode)
    if (readCommercialPriceKind(draft) !== input.priceKindId) throw await invalidDefinition('price_kind_mismatch')

    const em = resolveEm(ctx)
    const taken = await em.count(ConfigurationModel, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      modelKey: input.modelKey,
      deletedAt: null,
    })
    if (taken > 0) throw await duplicateModelKey()

    const model = em.create(ConfigurationModel, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      productId: input.productId,
      modelKey: input.modelKey,
      title: input.title,
      currencyCode: input.currencyCode,
      draftDefinition: draft,
      draftHash: computeDraftHash(draft),
      latestVersionId: null,
    })
    em.persist(model)
    try {
      await em.flush()
    } catch (error) {
      if (isUniqueViolation(error, MODEL_KEY_UNIQUE_INDEX)) throw await duplicateModelKey()
      throw error
    }

    await emitCrudSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'created',
      entity: model,
      identifiers: modelIdentifiers(model),
      syncOrigin: ctx.syncOrigin,
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
    return { id: model.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const scope = await resolveModelScope(ctx)
    const model = await findLiveModel(resolveEm(ctx), result.id, scope)
    if (!model) return null
    const snapshot: ModelCreateSnapshot = { ...toModelAuditSnapshot(model), draftDefinition: model.draftDefinition }
    return snapshot
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const after = snapshots.after as ModelCreateSnapshot | null | undefined
    return {
      actionLabel: translate('product_configurator.audit.models.create', 'Create configuration model'),
      resourceKind: MODEL_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: after?.tenantId ?? null,
      organizationId: after?.organizationId ?? null,
      snapshotAfter: after ? withoutDraft(after) : null,
      payload: { undo: { after: after ?? null } satisfies ModelCreateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const after = extractUndoPayload<ModelCreateUndoPayload>(logEntry)?.after
    if (!after) return
    const scope = resolveReplayScope(ctx, after)
    const em = resolveEm(ctx)
    const model = await findLiveModel(em, after.id, scope)
    if (!model) return
    model.deletedAt = new Date()
    await em.flush()
    await emitCrudUndoSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'deleted',
      entity: model,
      identifiers: modelIdentifiers(model),
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
  },
  redo: makeCreateRedo<ConfigurationModel, ModelCreateSnapshot, ModelCreateInput, { id: string }>({
    entityClass: ConfigurationModel,
    findRow: ({ em, ctx, id, snapshot }) => findModelForReplay(em, id, resolveReplayScope(ctx, snapshot)),
    buildResult: (model) => ({ id: model.id }),
    events: modelCrudEvents,
    indexer: modelCrudIndexer,
  }),
}

function toDraftSnapshot(model: ConfigurationModel): ModelDraftSnapshot {
  return {
    id: model.id,
    tenantId: model.tenantId,
    organizationId: model.organizationId,
    title: model.title,
    draftHash: model.draftHash,
    draftDefinition: model.draftDefinition,
  }
}

export type ModelUpdateResult = { id: string; updatedAt: string; draftHash: string }

const updateModelCommand: CommandHandler<ModelUpdateInput, ModelUpdateResult> = {
  id: 'product_configurator.models.update',
  prepareSnapshotInsideTransaction: true,
  async prepare(rawInput, ctx) {
    const input = modelUpdateSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const model = await findLiveModel(ctx.transactionalEm ?? resolveEm(ctx), input.id, scope)
    return model ? { before: toDraftSnapshot(model) } : {}
  },
  async execute(rawInput, ctx) {
    const input = modelUpdateSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const em = resolveEm(ctx)
    const model = await writeLockedModel(em, input, scope, ctx, 'product_configurator.models.update', async (locked) => {
      if (input.draftDefinition !== undefined) {
        await assertDraftAccepted(input.draftDefinition, locked.currencyCode)
        locked.draftDefinition = input.draftDefinition
        locked.draftHash = computeDraftHash(input.draftDefinition)
      }
      if (input.title !== undefined) locked.title = input.title
    })

    await emitCrudSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'updated',
      entity: model,
      identifiers: modelIdentifiers(model),
      syncOrigin: ctx.syncOrigin,
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
    return { id: model.id, updatedAt: model.updatedAt.toISOString(), draftHash: model.draftHash }
  },
  captureAfter: async (_input, result, ctx) => {
    const scope = await resolveModelScope(ctx)
    const model = await findLiveModel(resolveEm(ctx), result.id, scope)
    return model ? toModelAuditSnapshot(model) : null
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as ModelDraftSnapshot | null | undefined
    const after = snapshots.after as ModelAuditSnapshot | null | undefined
    return {
      actionLabel: translate('product_configurator.audit.models.update', 'Update configuration model'),
      resourceKind: MODEL_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: after?.tenantId ?? before?.tenantId ?? null,
      organizationId: after?.organizationId ?? before?.organizationId ?? null,
      snapshotBefore: before ? { title: before.title, draftHash: before.draftHash } : null,
      snapshotAfter: after ?? null,
      payload: { undo: { before: before ?? null } satisfies ModelUpdateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const before = extractUndoPayload<ModelUpdateUndoPayload>(logEntry)?.before
    if (!before) return
    const scope = resolveReplayScope(ctx, before)
    const em = resolveEm(ctx)
    const model = await findLiveModel(em, before.id, scope)
    if (!model) return
    model.title = before.title
    model.draftDefinition = before.draftDefinition
    model.draftHash = before.draftHash
    await em.flush()
    await emitCrudUndoSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'updated',
      entity: model,
      identifiers: modelIdentifiers(model),
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
  },
}

const deleteModelCommand: CommandHandler<ModelIdInput, { id: string }> = {
  id: 'product_configurator.models.delete',
  prepareSnapshotInsideTransaction: true,
  async prepare(rawInput, ctx) {
    const input = modelIdSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const model = await findLiveModel(ctx.transactionalEm ?? resolveEm(ctx), input.id, scope)
    return model ? { before: toModelAuditSnapshot(model) } : {}
  },
  async execute(rawInput, ctx) {
    const input = modelIdSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const em = resolveEm(ctx)
    const model = await writeLockedModel(em, input, scope, ctx, 'product_configurator.models.delete', (locked) => {
      locked.deletedAt = new Date()
    })

    await emitCrudSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'deleted',
      entity: model,
      identifiers: modelIdentifiers(model),
      syncOrigin: ctx.syncOrigin,
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
    return { id: model.id }
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as ModelAuditSnapshot | null | undefined
    return {
      actionLabel: translate('product_configurator.audit.models.delete', 'Delete configuration model'),
      resourceKind: MODEL_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before ?? null,
      payload: { undo: { before: before ?? null } satisfies ModelDeleteUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const before = extractUndoPayload<ModelDeleteUndoPayload>(logEntry)?.before
    if (!before) return
    const scope = resolveReplayScope(ctx, before)
    const em = resolveEm(ctx)
    const model = await findModelForReplay(em, before.id, scope)
    if (!model || !model.deletedAt) return
    model.deletedAt = null
    try {
      await em.flush()
    } catch (error) {
      if (isUniqueViolation(error, MODEL_KEY_UNIQUE_INDEX)) throw await duplicateModelKey()
      throw error
    }
    await emitCrudUndoSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'created',
      entity: model,
      identifiers: modelIdentifiers(model),
      events: modelCrudEvents,
      indexer: modelCrudIndexer,
    })
  },
}

async function validationFailed(report: unknown): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(422, {
    error: translate('product_configurator.errors.validation_failed', 'The model has publication errors.'),
    code: 'validation_failed',
    report,
  })
}

async function draftChanged(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(409, {
    error: translate('product_configurator.errors.draft_changed', 'The draft changed while it was being published. Reload and try again.'),
    code: 'draft_changed',
  })
}

async function emitPublished(result: ModelPublishResult, model: ConfigurationModel): Promise<void> {
  try {
    await emitProductConfiguratorEvent('product_configurator.model_version.published', {
      modelId: model.id,
      modelVersionId: result.modelVersionId,
      version: result.version,
      hash: result.hash,
      tenantId: model.tenantId,
      organizationId: model.organizationId,
    })
  } catch (error) {
    logger.error('Failed to emit model_version.published', { err: error, modelId: model.id })
    getTelemetryRuntime()?.reportError(error, {
      module: 'product_configurator',
      code: 'product_configurator.publish_event_failed',
    })
  }
}

const publishModelCommand: CommandHandler<ModelIdInput, ModelPublishResult> = {
  id: 'product_configurator.models.publish',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = modelIdSchema.parse(rawInput)
    const scope = await resolveModelScope(ctx)
    const em = resolveEm(ctx)
    const model = await loadModelInScope(em, input.id, scope, ctx)

    const report = await validateModelDraft(em, ctx.container, model)
    if (!report.ok) throw await validationFailed(report)
    const parsed = definitionSchema.safeParse(model.draftDefinition)
    if (!parsed.success) throw await validationFailed(report)
    const hash = hashDefinition(parsed.data)
    const validatedDraftHash = model.draftHash

    const result = await em.transactional(async (trx) => {
      const locked = await assertModelVersion(
        await findLiveModel(trx, model.id, scope, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true }),
        model.id,
        ctx,
      )
      if (locked.draftHash !== validatedDraftHash) throw await draftChanged()

      const latest = await findOneWithDecryption(
        trx,
        ConfigurationModelVersion,
        { modelId: locked.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
        { orderBy: { version: 'desc' } },
        scope,
      )
      const version = trx.create(ConfigurationModelVersion, {
        id: randomUUID(),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        modelId: locked.id,
        version: (latest?.version ?? 0) + 1,
        definition: parsed.data,
        validationReport: report,
        hash,
        publishedAt: new Date(),
      })
      trx.persist(version)
      locked.latestVersionId = version.id
      locked.draftHash = hash
      await trx.flush()
      return { modelVersionId: version.id, version: version.version, hash, model: locked }
    })

    await emitCrudSideEffects({
      dataEngine: resolveDataEngine(ctx),
      action: 'updated',
      entity: result.model,
      identifiers: modelIdentifiers(result.model),
      syncOrigin: ctx.syncOrigin,
      indexer: modelCrudIndexer,
    })
    const published: ModelPublishResult = {
      modelVersionId: result.modelVersionId,
      version: result.version,
      hash: result.hash,
      updatedAt: result.model.updatedAt.toISOString(),
    }
    await emitPublished(published, result.model)
    return published
  },
  buildLog: async ({ input, result, ctx }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('product_configurator.audit.models.publish', 'Publish configuration model'),
      resourceKind: MODEL_RESOURCE_KIND,
      resourceId: modelIdSchema.parse(input).id,
      tenantId: commandTenantId(ctx),
      organizationId: ctx.selectedOrganizationId ?? null,
      snapshotAfter: result,
    }
  },
}

registerCommand(createModelCommand)
registerCommand(updateModelCommand)
registerCommand(deleteModelCommand)
registerCommand(publishModelCommand)

export { createModelCommand, updateModelCommand, deleteModelCommand, publishModelCommand }
