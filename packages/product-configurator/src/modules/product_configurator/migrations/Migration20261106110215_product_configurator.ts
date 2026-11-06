import { Migration } from '@mikro-orm/migrations';

export class Migration20261106110215_product_configurator extends Migration {

  override name = 'Migration20261106110215';

  override up(): void | Promise<void> {
    this.addSql(`create table "product_configurator_sessions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "model_version_id" uuid not null, "quote_id" uuid not null, "selections" jsonb not null, "evaluation" jsonb null, "revision" int not null default 0, "mode" text not null default 'new', "migration" jsonb null, "status" text not null default 'open', "created_by" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "product_configurator_sessions_status_idx" on "product_configurator_sessions" ("tenant_id", "organization_id", "status");`);
    this.addSql(`create index "product_configurator_sessions_quote_idx" on "product_configurator_sessions" ("tenant_id", "organization_id", "quote_id");`);

    this.addSql(`create table "product_configurator_snapshots" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "model_version_id" uuid not null, "model_version_hash" text not null, "session_id" uuid not null, "quote_id" uuid not null, "quote_line_id" uuid null, "selections" jsonb not null, "calculated" jsonb not null, "bom" jsonb not null, "warnings" jsonb not null, "price_context" jsonb not null, "net_price" numeric(18,4) not null, "currency_code" text not null, "summary" text not null, "hash" text not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "product_configurator_snapshots_created_idx" on "product_configurator_snapshots" ("tenant_id", "organization_id", "created_at");`);
    this.addSql(`create index "product_configurator_snapshots_quote_idx" on "product_configurator_snapshots" ("tenant_id", "organization_id", "quote_id");`);
    this.addSql(`alter table "product_configurator_snapshots" add constraint "product_configurator_snapshots_session_unique" unique ("session_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "product_configurator_snapshots";`);
    this.addSql(`drop table if exists "product_configurator_sessions";`);
  }

}
