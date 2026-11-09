/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Migration20261106110215_product_configurator } from '../Migration20261106110215_product_configurator'
import { Migration20261106164348_product_configurator } from '../Migration20261106164348_product_configurator'

/**
 * Runs the `source_snapshot_id` migration up -> down -> up against a real PostgreSQL, on top of the
 * sessions table from the Phase C migration. Everything happens inside one transaction in a scratch
 * schema that is rolled back at the end, so no real table is touched. Skipped unless DATABASE_URL is set.
 */
const DATABASE_URL = process.env.DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

const SESSIONS_TABLE = 'product_configurator_sessions'
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'

type MigrationClass = { prototype: { up(): void | Promise<void>; down(): void | Promise<void> } }

describeWithPostgres('Migration20261106164348_product_configurator against PostgreSQL', () => {
  jest.setTimeout(30_000)
  let client: Client | undefined
  const schema = `pcfg_migration_${randomUUID().replaceAll('-', '')}`

  function database(): Client {
    if (!client) throw new Error('[internal] migration test database is not connected')
    return client
  }

  async function migrate(migrationClass: MigrationClass, direction: 'up' | 'down'): Promise<void> {
    const migration = Object.create(migrationClass.prototype) as MigrationClass['prototype']
    const statements: string[] = []
    Object.defineProperty(migration, 'addSql', { value: (sql: string) => statements.push(sql) })
    await migration[direction]()
    for (const statement of statements) await database().query(statement)
  }

  async function sourceColumn(): Promise<{ data_type: string; is_nullable: string } | null> {
    const { rows } = await database().query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
       where table_schema = $1 and table_name = $2 and column_name = 'source_snapshot_id'`,
      [schema, SESSIONS_TABLE],
    )
    return rows[0] ?? null
  }

  async function insertSession(sourceSnapshotId: string | null): Promise<string | null> {
    const { rows } = await database().query<{ source_snapshot_id: string | null }>(
      `insert into ${SESSIONS_TABLE} (tenant_id, organization_id, model_version_id, quote_id, source_snapshot_id, mode, selections, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'duplicate', '{}'::jsonb, now(), now()) returning source_snapshot_id`,
      [TENANT_ID, ORGANIZATION_ID, randomUUID(), randomUUID(), sourceSnapshotId],
    )
    return rows[0].source_snapshot_id
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query('begin')
    await client.query(`create schema "${schema}"`)
    await client.query(`set local search_path to "${schema}"`)
    await migrate(Migration20261106110215_product_configurator, 'up')
  })

  afterAll(async () => {
    try {
      await client?.query('rollback')
    } finally {
      await client?.end()
    }
  })

  it('adds the nullable source_snapshot_id column, drops it, and adds it again', async () => {
    expect(await sourceColumn()).toBeNull()

    await migrate(Migration20261106164348_product_configurator, 'up')
    expect(await sourceColumn()).toEqual({ data_type: 'uuid', is_nullable: 'YES' })
    const source = randomUUID()
    expect(await insertSession(source)).toBe(source)
    expect(await insertSession(null)).toBeNull()

    await migrate(Migration20261106164348_product_configurator, 'down')
    expect(await sourceColumn()).toBeNull()
    const { rows } = await database().query<{ count: string }>(`select count(*)::text as count from ${SESSIONS_TABLE}`)
    expect(rows[0].count).toBe('2')

    await migrate(Migration20261106164348_product_configurator, 'up')
    expect(await sourceColumn()).toEqual({ data_type: 'uuid', is_nullable: 'YES' })
  })
})
