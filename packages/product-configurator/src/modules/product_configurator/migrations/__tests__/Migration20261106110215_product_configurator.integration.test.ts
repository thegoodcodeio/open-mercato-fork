/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Migration20261106110215_product_configurator } from '../Migration20261106110215_product_configurator'

/**
 * Runs the sessions and snapshots migration up -> down -> up against a real PostgreSQL. Everything
 * happens inside one transaction in a scratch schema that is rolled back at the end, so no real
 * table is touched. Skipped unless DATABASE_URL is set, for example:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/open-mercato yarn jest Migration20261106110215
 */
const DATABASE_URL = process.env.DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

const SESSIONS_TABLE = 'product_configurator_sessions'
const SNAPSHOTS_TABLE = 'product_configurator_snapshots'
const SNAPSHOT_SESSION_UNIQUE = 'product_configurator_snapshots_session_unique'
const SESSION_INDEXES = [
  'product_configurator_sessions_pkey',
  'product_configurator_sessions_quote_idx',
  'product_configurator_sessions_status_idx',
]
const SNAPSHOT_INDEXES = [
  'product_configurator_snapshots_created_idx',
  'product_configurator_snapshots_pkey',
  'product_configurator_snapshots_quote_idx',
  SNAPSHOT_SESSION_UNIQUE,
]
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'

describeWithPostgres('Migration20261106110215_product_configurator against PostgreSQL', () => {
  jest.setTimeout(30_000)
  let client: Client | undefined
  const schema = `pcfg_migration_${randomUUID().replaceAll('-', '')}`

  function database(): Client {
    if (!client) throw new Error('[internal] migration test database is not connected')
    return client
  }

  async function migrate(direction: 'up' | 'down'): Promise<void> {
    const migration = Object.create(Migration20261106110215_product_configurator.prototype) as Migration20261106110215_product_configurator
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

  async function indexNames(table: string): Promise<string[]> {
    const { rows } = await database().query<{ indexname: string }>(
      'select indexname from pg_indexes where schemaname = $1 and tablename = $2 order by indexname',
      [schema, table],
    )
    return rows.map((row) => row.indexname)
  }

  async function insertSession(): Promise<{ id: string; revision: number; mode: string; status: string }> {
    const { rows } = await database().query<{ id: string; revision: number; mode: string; status: string }>(
      `insert into ${SESSIONS_TABLE} (tenant_id, organization_id, model_version_id, quote_id, selections, created_at, updated_at)
       values ($1, $2, $3, $4, '{}'::jsonb, now(), now()) returning id, revision, mode, status`,
      [TENANT_ID, ORGANIZATION_ID, randomUUID(), randomUUID()],
    )
    return rows[0]
  }

  async function insertSnapshot(sessionId: string): Promise<void> {
    await database().query(
      `insert into ${SNAPSHOTS_TABLE} (tenant_id, organization_id, model_version_id, model_version_hash, session_id, quote_id,
         selections, calculated, bom, warnings, price_context, net_price, currency_code, summary, hash, created_at)
       values ($1, $2, $3, 'version-hash', $4, $5, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
         12.3456, 'EUR', 'Size: Large', 'hash', now())`,
      [TENANT_ID, ORGANIZATION_ID, randomUUID(), sessionId, randomUUID()],
    )
  }

  async function expectMigratedSchema(): Promise<void> {
    expect(await tableNames()).toEqual([SESSIONS_TABLE, SNAPSHOTS_TABLE])
    expect(await indexNames(SESSIONS_TABLE)).toEqual(SESSION_INDEXES)
    expect(await indexNames(SNAPSHOTS_TABLE)).toEqual(SNAPSHOT_INDEXES)

    const session = await insertSession()
    expect(session).toMatchObject({ revision: 0, mode: 'new', status: 'open' })

    await insertSnapshot(session.id)
    const { rows } = await database().query<{ net_price: string; quote_line_id: string | null }>(
      `select net_price, quote_line_id from ${SNAPSHOTS_TABLE} where session_id = $1`,
      [session.id],
    )
    expect(rows).toEqual([{ net_price: '12.3456', quote_line_id: null }])

    await database().query('savepoint duplicate_check')
    await expect(insertSnapshot(session.id)).rejects.toMatchObject({ code: '23505', constraint: SNAPSHOT_SESSION_UNIQUE })
    await database().query('rollback to savepoint duplicate_check')
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

  it('creates the session and snapshot tables with their indexes, drops them, and creates them again', async () => {
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
