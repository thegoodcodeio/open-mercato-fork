import { Migration } from '@mikro-orm/migrations';

export class Migration20261106164348_product_configurator extends Migration {

  override name = 'Migration20261106164348';

  override up(): void | Promise<void> {
    this.addSql(`alter table "product_configurator_sessions" add "source_snapshot_id" uuid null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "product_configurator_sessions" drop column "source_snapshot_id";`);
  }

}
