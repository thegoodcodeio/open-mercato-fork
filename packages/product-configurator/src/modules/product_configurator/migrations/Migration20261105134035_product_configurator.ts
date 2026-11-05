import { Migration } from '@mikro-orm/migrations';

export class Migration20261105134035_product_configurator extends Migration {

  override name = 'Migration20261105134035';

  override up(): void | Promise<void> {
    this.addSql(`create table "product_configurator_models" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "product_id" uuid not null, "model_key" text not null, "title" text not null, "currency_code" text not null, "draft_definition" jsonb not null, "draft_hash" text not null, "latest_version_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "product_configurator_models_currency_idx" on "product_configurator_models" ("tenant_id", "organization_id", "currency_code");`);
    this.addSql(`create index "product_configurator_models_product_idx" on "product_configurator_models" ("tenant_id", "organization_id", "product_id");`);
    this.addSql(`create unique index "product_configurator_models_model_key_unique" on "product_configurator_models" ("tenant_id", "organization_id", "model_key") where "deleted_at" is null;`);

    this.addSql(`create table "product_configurator_model_versions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "model_id" uuid not null, "version" int not null, "definition" jsonb not null, "validation_report" jsonb not null, "hash" text not null, "published_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "product_configurator_model_versions" add constraint "product_configurator_model_versions_model_version_unique" unique ("model_id", "version");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "product_configurator_model_versions";`);
    this.addSql(`drop table if exists "product_configurator_models";`);
  }

}
