/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Migration20261105134035_product_configurator } from '../Migration20261105134035_product_configurator'

/**
 * Runs the migration up -> down -> up against a real PostgreSQL. Everything happens inside one
 * transaction in a scratch schema that is rolled back at the end, so no real table is touched.
 * Skipped unless DATABASE_URL is set, for example:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/open-mercato yarn jest Migration20261105134035
 */
const DATABASE_URL = process.env.DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

const MODELS_TABLE = 'product_configurator_models'
const VERSIONS_TABLE = 'product_configurator_model_versions'
const MODEL_KEY_UNIQUE = 'product_configurator_models_model_key_unique'
const MODEL_VERSION_UNIQUE = 'product_configurator_model_versions_model_version_unique'
const MODEL_INDEXES = [
  'product_configurator_models_currency_idx',
  MODEL_KEY_UNIQUE,
  'product_configurator_models_pkey',
  'product_configurator_models_product_idx',
]
const VERSION_INDEXES = [MODEL_VERSION_UNIQUE, 'product_configurator_model_versions_pkey']

describeWithPostgres('Migration20261105134035_product_configurator against PostgreSQL', () => {
  jest.setTimeout(30_000)
  let client: Client | undefined
  const schema = `pcfg_migration_${randomUUID().replaceAll('-', '')}`

  function database(): Client {
    if (!client) throw new Error('[internal] migration test database is not connected')
    return client
  }

  async function migrate(direction: 'up' | 'down'): Promise<void> {
    const migration = Object.create(Migration20261105134035_product_configurator.prototype) as Migration20261105134035_product_configurator
    const statements: string[] = []
    Object.defineProperty(migration, 'addSql', { value: (sql: string) => statements.push(sql) })
    await migration[direction]()
    for (const statement of statements) await database().query(statement)
  }

  async function tableNames(): Promise<string[]> {
    const { rows } = await database().query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [schema],
    )
    return rows.map((row) => row.table_name)
  }

  async function indexes(table: string): Promise<Array<{ indexname: string; indexdef: string }>> {
    const { rows } = await database().query<{ indexname: string; indexdef: string }>(
      'select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = $2 order by indexname',
      [schema, table],
    )
    return rows
  }

  async function insertModel(modelKey: string, deletedAt: string | null): Promise<void> {
    await database().query(
      `insert into ${MODELS_TABLE} (tenant_id, organization_id, product_id, model_key, title, currency_code, draft_definition, draft_hash, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, 'Model', 'EUR', '{}'::jsonb, 'hash', now(), now(), $5)`,
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', randomUUID(), modelKey, deletedAt],
    )
  }

  async function expectRejectedInSavepoint(run: () => Promise<void>, constraint: string): Promise<void> {
    await database().query('savepoint duplicate_check')
    await expect(run()).rejects.toMatchObject({ code: '23505', constraint })
    await database().query('rollback to savepoint duplicate_check')
  }

  async function expectMigratedSchema(): Promise<void> {
    expect(await tableNames()).toEqual([VERSIONS_TABLE, MODELS_TABLE])

    const modelIndexes = await indexes(MODELS_TABLE)
    expect(modelIndexes.map((index) => index.indexname)).toEqual(MODEL_INDEXES)
    const modelKeyIndex = modelIndexes.find((index) => index.indexname === MODEL_KEY_UNIQUE)
    expect(modelKeyIndex?.indexdef).toContain('CREATE UNIQUE INDEX')
    expect(modelKeyIndex?.indexdef).toContain('(tenant_id, organization_id, model_key)')
    expect(modelKeyIndex?.indexdef).toContain('WHERE (deleted_at IS NULL)')

    expect((await indexes(VERSIONS_TABLE)).map((index) => index.indexname)).toEqual(VERSION_INDEXES)
    const { rows: constraints } = await database().query<{ conname: string; contype: string }>(
      `select c.conname, c.contype from pg_constraint c join pg_namespace n on n.oid = c.connamespace
       where n.nspname = $1 and c.conname = $2`,
      [schema, MODEL_VERSION_UNIQUE],
    )
    expect(constraints).toEqual([{ conname: MODEL_VERSION_UNIQUE, contype: 'u' }])

    const modelKey = `pump-${randomUUID()}`
    await insertModel(modelKey, null)
    await expectRejectedInSavepoint(() => insertModel(modelKey, null), MODEL_KEY_UNIQUE)
    await insertModel(modelKey, new Date().toISOString())

    const modelId = randomUUID()
    const insertVersion = () =>
      database()
        .query(
          `insert into ${VERSIONS_TABLE} (tenant_id, organization_id, model_id, version, definition, validation_report, hash, published_at)
           values ($1, $2, $3, 1, '{}'::jsonb, '{}'::jsonb, 'hash', now())`,
          ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', modelId],
        )
        .then(() => undefined)
    await insertVersion()
    await expectRejectedInSavepoint(insertVersion, MODEL_VERSION_UNIQUE)
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query('begin')
    await client.query(`create schema "${schema}"`)
    await client.query(`set local search_path to "${schema}"`)
  })

  afterAll(async () => {
    try {
      await client?.query('rollback')
    } finally {
      await client?.end()
    }
  })

  it('creates the tables, indexes and unique constraints, drops them all, and creates them again', async () => {
    expect(await tableNames()).toEqual([])

    await migrate('up')
    await expectMigratedSchema()

    await migrate('down')
    expect(await tableNames()).toEqual([])
    const { rows: leftovers } = await database().query('select indexname from pg_indexes where schemaname = $1', [schema])
    expect(leftovers).toEqual([])

    await migrate('up')
    await expectMigratedSchema()
  })
})
