import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

@Entity({ tableName: 'product_configurator_models' })
@Index({
  name: 'product_configurator_models_model_key_unique',
  expression:
    'create unique index "product_configurator_models_model_key_unique" on "product_configurator_models" ("tenant_id", "organization_id", "model_key") where "deleted_at" is null',
})
@Index({ name: 'product_configurator_models_product_idx', properties: ['tenantId', 'organizationId', 'productId'] })
@Index({ name: 'product_configurator_models_currency_idx', properties: ['tenantId', 'organizationId', 'currencyCode'] })
export class ConfigurationModel {
  [OptionalProps]?: 'latestVersionId' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'product_id', type: 'uuid' })
  productId!: string

  @Property({ name: 'model_key', type: 'text' })
  modelKey!: string

  @Property({ name: 'title', type: 'text' })
  title!: string

  @Property({ name: 'currency_code', type: 'text' })
  currencyCode!: string

  @Property({ name: 'draft_definition', type: 'json' })
  draftDefinition!: Record<string, unknown>

  @Property({ name: 'draft_hash', type: 'text' })
  draftHash!: string

  @Property({ name: 'latest_version_id', type: 'uuid', nullable: true })
  latestVersionId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'product_configurator_model_versions' })
@Unique({ name: 'product_configurator_model_versions_model_version_unique', properties: ['modelId', 'version'] })
export class ConfigurationModelVersion {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'model_id', type: 'uuid' })
  modelId!: string

  @Property({ name: 'version', type: 'int' })
  version!: number

  @Property({ name: 'definition', type: 'json' })
  definition!: Record<string, unknown>

  @Property({ name: 'validation_report', type: 'json' })
  validationReport!: Record<string, unknown>

  @Property({ name: 'hash', type: 'text' })
  hash!: string

  @Property({ name: 'published_at', type: Date })
  publishedAt!: Date
}

export type ConfigurationSessionStatus = 'open' | 'finalising' | 'finalised' | 'cancelled'
export type ConfigurationSessionMode = 'new' | 'duplicate'

/**
 * A configuration in progress on one quote, pinned to the model version it was opened with.
 * `selections` holds the user's intent only; the settled result lives in `evaluation`.
 * `revision` guards evaluate and finalise against stale writers.
 */
@Entity({ tableName: 'product_configurator_sessions' })
@Index({ name: 'product_configurator_sessions_quote_idx', properties: ['tenantId', 'organizationId', 'quoteId'] })
@Index({ name: 'product_configurator_sessions_status_idx', properties: ['tenantId', 'organizationId', 'status'] })
export class ConfigurationSession {
  [OptionalProps]?: 'sourceSnapshotId' | 'evaluation' | 'revision' | 'mode' | 'migration' | 'status' | 'createdBy' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'model_version_id', type: 'uuid' })
  modelVersionId!: string

  @Property({ name: 'quote_id', type: 'uuid' })
  quoteId!: string

  @Property({ name: 'source_snapshot_id', type: 'uuid', nullable: true })
  sourceSnapshotId?: string | null

  @Property({ name: 'selections', type: 'json' })
  selections!: Record<string, unknown>

  @Property({ name: 'evaluation', type: 'json', nullable: true })
  evaluation?: Record<string, unknown> | null

  @Property({ name: 'revision', type: 'int', default: 0 })
  revision: number = 0

  @Property({ name: 'mode', type: 'text', default: 'new' })
  mode: ConfigurationSessionMode = 'new'

  @Property({ name: 'migration', type: 'json', nullable: true })
  migration?: Record<string, unknown> | null

  @Property({ name: 'status', type: 'text', default: 'open' })
  status: ConfigurationSessionStatus = 'open'

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * The priced result a finalise wrote to a quote line. Replaceable only while `quoteLineId` is
 * null (an unfinished finalise); immutable once a line carries it.
 */
@Entity({ tableName: 'product_configurator_snapshots' })
@Unique({ name: 'product_configurator_snapshots_session_unique', properties: ['sessionId'] })
@Index({ name: 'product_configurator_snapshots_quote_idx', properties: ['tenantId', 'organizationId', 'quoteId'] })
@Index({ name: 'product_configurator_snapshots_created_idx', properties: ['tenantId', 'organizationId', 'createdAt'] })
export class ConfigurationSnapshot {
  [OptionalProps]?: 'quoteLineId' | 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'model_version_id', type: 'uuid' })
  modelVersionId!: string

  @Property({ name: 'model_version_hash', type: 'text' })
  modelVersionHash!: string

  @Property({ name: 'session_id', type: 'uuid' })
  sessionId!: string

  @Property({ name: 'quote_id', type: 'uuid' })
  quoteId!: string

  @Property({ name: 'quote_line_id', type: 'uuid', nullable: true })
  quoteLineId?: string | null

  @Property({ name: 'selections', type: 'json' })
  selections!: Record<string, unknown>

  @Property({ name: 'calculated', type: 'json' })
  calculated!: Record<string, unknown>

  @Property({ name: 'bom', type: 'json' })
  bom!: Array<Record<string, unknown>>

  @Property({ name: 'warnings', type: 'json' })
  warnings!: Array<Record<string, unknown>>

  @Property({ name: 'price_context', type: 'json' })
  priceContext!: Record<string, unknown>

  @Property({ name: 'net_price', type: 'numeric', precision: 18, scale: 4 })
  netPrice!: string

  @Property({ name: 'currency_code', type: 'text' })
  currencyCode!: string

  @Property({ name: 'summary', type: 'text' })
  summary!: string

  @Property({ name: 'hash', type: 'text' })
  hash!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}
