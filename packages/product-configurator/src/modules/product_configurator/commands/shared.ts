import type { FindOneOptions } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { ORGANIZATION_SCOPE_REQUIRED_ERROR_CODE } from '@open-mercato/shared/lib/auth/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { ConfigurationModel } from '../data/entities'

export const MODEL_RESOURCE_KIND = 'product_configurator.model'
export const MODEL_ENTITY_TYPE = 'product_configurator:configuration_model'

export type ModelScope = { tenantId: string; organizationId: string }

export const modelCrudIndexer: CrudIndexerConfig<ConfigurationModel> = {
  entityType: MODEL_ENTITY_TYPE,
}

export const modelCrudEvents: CrudEventsConfig<ConfigurationModel> = {
  module: 'product_configurator',
  entity: 'model',
  persistent: true,
  buildPayload: (ctx) => ({
    id: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
}

/** Trusted server-side contexts (seeding) carry no `auth` and name the tenant on `organizationScope`, as in catalog commands. */
export function commandTenantId(ctx: CommandRuntimeContext): string | null {
  return ctx.auth ? (ctx.auth.tenantId ?? null) : (ctx.organizationScope?.tenantId ?? null)
}

/** Model writes need one tenant and one selected organization; "all organizations" is rejected. */
export async function resolveModelScope(ctx: CommandRuntimeContext): Promise<ModelScope> {
  const tenantId = commandTenantId(ctx)
  const organizationId = ctx.selectedOrganizationId ?? null
  if (!tenantId || !organizationId) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(400, {
      error: translate('product_configurator.errors.organization_scope_required', 'Select an organization to manage configuration models.'),
      code: ORGANIZATION_SCOPE_REQUIRED_ERROR_CODE,
    })
  }
  ensureTenantScope(ctx, tenantId)
  ensureOrganizationScope(ctx, organizationId)
  return { tenantId, organizationId }
}

export function resolveReplayScope(ctx: CommandRuntimeContext, snapshot: ModelScope): ModelScope {
  ensureTenantScope(ctx, snapshot.tenantId)
  ensureOrganizationScope(ctx, snapshot.organizationId)
  return { tenantId: snapshot.tenantId, organizationId: snapshot.organizationId }
}

export async function findLiveModel(
  em: EntityManager,
  id: string,
  scope: ModelScope,
  options?: FindOneOptions<ConfigurationModel>,
): Promise<ConfigurationModel | null> {
  return findOneWithDecryption(
    em,
    ConfigurationModel,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    options,
    scope,
  )
}

export async function modelNotFound(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(404, {
    error: translate('product_configurator.errors.model_not_found', 'Configuration model not found.'),
    code: 'model_not_found',
  })
}

/** The audit view of a model leaves the definition out; undo payloads carry what they need. */
export type ModelAuditSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  productId: string
  modelKey: string
  title: string
  currencyCode: string
  draftHash: string
  latestVersionId: string | null
}

export function toModelAuditSnapshot(model: ConfigurationModel): ModelAuditSnapshot {
  return {
    id: model.id,
    tenantId: model.tenantId,
    organizationId: model.organizationId,
    productId: model.productId,
    modelKey: model.modelKey,
    title: model.title,
    currencyCode: model.currencyCode,
    draftHash: model.draftHash,
    latestVersionId: model.latestVersionId ?? null,
  }
}
