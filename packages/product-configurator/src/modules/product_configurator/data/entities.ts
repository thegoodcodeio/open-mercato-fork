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
