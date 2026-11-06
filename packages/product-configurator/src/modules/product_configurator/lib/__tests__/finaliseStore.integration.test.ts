/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { MikroORM } from '@mikro-orm/postgresql'
import { Client } from 'pg'
import { createQuoteLock, QUOTE_LOCK_CONNECTIONS, QUOTE_LOCK_WAIT_MS, quoteLockKey } from '../finaliseStore'

/**
 * Real PostgreSQL behaviour finalise relies on: the per-quote session-level advisory lock, and the
 * serialization of a conversion with a concurrent configured line insert. Skipped unless DATABASE_URL
 * is set, for example:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/open-mercato yarn jest finaliseStore
 * The conversion test works in a scratch schema dropped at the end; it touches no real table.
 */
const DATABASE_URL = process.env.DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  return client
}

describeWithPostgres('quote lock against PostgreSQL', () => {
  jest.setTimeout(30_000)
  let orm: MikroORM
  let observer: Client

  beforeAll(async () => {
    orm = await MikroORM.init({ clientUrl: DATABASE_URL, entities: [], discovery: { warnWhenNoEntities: false }, debug: false })
    observer = await connect()
  })

  afterAll(async () => {
    await observer?.end()
    await orm?.close(true)
  })

  async function lockHolderPid(quoteId: string): Promise<number | null> {
    const { rows } = await observer.query<{ pid: number }>(
      `select pid from pg_locks
        where locktype = 'advisory' and granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [quoteLockKey(quoteId)],
    )
    return rows[0]?.pid ?? null
  }

  it('refuses a second holder of the same quote while the first holds it, and releases it at the end', async () => {
    const quoteId = randomUUID()
    const otherQuoteId = randomUUID()
    const first = createQuoteLock(orm.em.fork())
    const second = createQuoteLock(orm.em.fork())

    const outcome = await first.withLock(quoteId, async (held) => {
      await held.assertHeld()
      expect(await lockHolderPid(quoteId)).not.toBeNull()
      const busy = await second.withLock(quoteId, async () => 'second')
      const other = await second.withLock(otherQuoteId, async () => 'other')
      return { busy, other }
    })

    expect(outcome).toEqual({ acquired: true, value: { busy: { acquired: false, reason: 'held' }, other: { acquired: true, value: 'other' } } })
    expect(await lockHolderPid(quoteId)).toBeNull()
    await expect(second.withLock(quoteId, async () => 'again')).resolves.toEqual({ acquired: true, value: 'again' })
  })

  it('releases the lock when its holder throws', async () => {
    const quoteId = randomUUID()
    const lock = createQuoteLock(orm.em.fork())
    await expect(lock.withLock(quoteId, async () => Promise.reject(new Error('finalise failed')))).rejects.toThrow('finalise failed')
    expect(await lockHolderPid(quoteId)).toBeNull()
  })

  it('reports a lost lock connection before the next write, and PostgreSQL frees the lock with the connection', async () => {
    const quoteId = randomUUID()
    const lock = createQuoteLock(orm.em.fork())
    const attempt = lock.withLock(quoteId, async (held) => {
      const pid = await lockHolderPid(quoteId)
      await observer.query('select pg_terminate_backend($1)', [pid])
      await held.assertHeld()
      return 'wrote anyway'
    })
    await expect(attempt).rejects.toThrow()
    expect(await lockHolderPid(quoteId)).toBeNull()
    await expect(createQuoteLock(orm.em.fork()).withLock(quoteId, async () => 'next')).resolves.toEqual({ acquired: true, value: 'next' })
  })
})

describeWithPostgres('quote lock connection against PostgreSQL', () => {
  jest.setTimeout(30_000)
  const applicationName = `pcfg_lock_${randomUUID().slice(0, 8)}`
  let orm: MikroORM
  let observer: Client

  beforeAll(async () => {
    orm = await MikroORM.init({
      clientUrl: DATABASE_URL,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      debug: false,
      pool: { min: 0, max: 1 },
      driverOptions: { application_name: applicationName },
    })
    observer = await connect()
  })

  afterAll(async () => {
    await observer?.end()
    await orm?.close(true)
  })

  async function heldLocks(quoteId: string): Promise<number> {
    const { rows } = await observer.query<{ count: string }>(
      `select count(*) from pg_locks
        where locktype = 'advisory' and granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [quoteLockKey(quoteId)],
    )
    return Number(rows[0].count)
  }

  it('holds the lock outside the app pool, so locks never exhaust it', async () => {
    const lock = createQuoteLock(orm.em.fork())
    const outcome = await lock.withLock(randomUUID(), async () =>
      lock.withLock(randomUUID(), async () => orm.em.fork().getConnection().execute('select 1 as one')),
    )
    expect(outcome).toEqual({ acquired: true, value: { acquired: true, value: [{ one: 1 }] } })
  })

  it('keeps the error of a finalise whose lock connection broke, and closes the connection', async () => {
    const quoteId = randomUUID()
    const lock = createQuoteLock(orm.em.fork())
    const attempt = lock.withLock(quoteId, async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `select pid from pg_locks
          where locktype = 'advisory' and granted and objsubid = 1
            and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
        [quoteLockKey(quoteId)],
      )
      await observer.query('select pg_terminate_backend($1)', [rows[0].pid])
      throw new Error('finalise failed')
    })
    await expect(attempt).rejects.toThrow('finalise failed')
    expect(await heldLocks(quoteId)).toBe(0)
  })

  async function applicationConnections(): Promise<number> {
    const { rows } = await observer.query<{ count: string }>('select count(*) from pg_stat_activity where application_name = $1', [applicationName])
    return Number(rows[0].count)
  }

  function gate(): { opened: Promise<void>; open: () => void } {
    let open = () => undefined as void
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    return { opened, open }
  }

  it('reuses one lock pool across finalises instead of opening a connection each time', async () => {
    const lock = createQuoteLock(orm.em.fork())
    await lock.withLock(randomUUID(), async () => undefined)
    const before = await applicationConnections()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => undefined)
    }
    expect(await applicationConnections()).toBe(before)
  })

  it('holds at most QUOTE_LOCK_CONNECTIONS locks at once; the next one waits for a free connection', async () => {
    const release = gate()
    const started: string[] = []
    const holders = Array.from({ length: QUOTE_LOCK_CONNECTIONS }, (_, index) =>
      createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => {
        started.push(`holder-${index}`)
        await release.opened
        return index
      }),
    )
    while (started.length < QUOTE_LOCK_CONNECTIONS) await new Promise((resolve) => setTimeout(resolve, 10))
    const waiting = createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => 'waited')
    await new Promise((resolve) => setTimeout(resolve, 100))
    release.open()
    await expect(waiting).resolves.toEqual({ acquired: true, value: 'waited' })
    await expect(Promise.all(holders)).resolves.toHaveLength(QUOTE_LOCK_CONNECTIONS)
  })

  it('answers busy when no lock connection frees up in time, so finalise reports finalise_busy', async () => {
    const release = gate()
    let started = 0
    const holders = Array.from({ length: QUOTE_LOCK_CONNECTIONS }, () =>
      createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => {
        started += 1
        await release.opened
      }),
    )
    while (started < QUOTE_LOCK_CONNECTIONS) await new Promise((resolve) => setTimeout(resolve, 10))
    const startedAt = Date.now()
    await expect(createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => 'never')).resolves.toEqual({ acquired: false, reason: 'busy' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(QUOTE_LOCK_WAIT_MS - 50)
    release.open()
    await Promise.all(holders)
    await expect(createQuoteLock(orm.em.fork()).withLock(randomUUID(), async () => 'free again')).resolves.toEqual({ acquired: true, value: 'free again' })
  })

  it('destroys a connection whose unlock failed, so the next finalise gets a working one', async () => {
    const quoteId = randomUUID()
    const lock = createQuoteLock(orm.em.fork())
    await expect(
      lock.withLock(quoteId, async () => {
        const { rows } = await observer.query<{ pid: number }>(
          `select pid from pg_locks
            where locktype = 'advisory' and granted and objsubid = 1
              and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
          [quoteLockKey(quoteId)],
        )
        await observer.query('select pg_terminate_backend($1)', [rows[0].pid])
        return 'done'
      }),
    ).resolves.toEqual({ acquired: true, value: 'done' })
    for (let attempt = 0; attempt < QUOTE_LOCK_CONNECTIONS + 1; attempt += 1) {
      await expect(lock.withLock(quoteId, async (held) => held.assertHeld().then(() => 'alive'))).resolves.toEqual({ acquired: true, value: 'alive' })
    }
  })
})

describeWithPostgres('conversion vs configured line insert against PostgreSQL', () => {
  jest.setTimeout(30_000)
  const schema = `pcfg_race_${randomUUID().replaceAll('-', '')}`
  let converter: Client
  let writer: Client

  beforeAll(async () => {
    converter = await connect()
    writer = await connect()
    await converter.query(`create schema "${schema}"`)
    await converter.query(`set search_path to "${schema}"`)
    await writer.query(`set search_path to "${schema}"`)
    await converter.query('create table sales_quotes (id uuid primary key)')
    await converter.query('create table sales_quote_lines (id uuid primary key, quote_id uuid not null, configuration jsonb)')
    await converter.query(
      'alter table sales_quote_lines add constraint sales_quote_lines_quote_id_foreign foreign key (quote_id) references sales_quotes (id) on update cascade',
    )
    await converter.query('create table sales_orders (id uuid primary key)')
    await converter.query('create table sales_order_lines (id uuid primary key, order_id uuid not null references sales_orders (id), configuration jsonb)')
  })

  afterAll(async () => {
    await writer?.end()
    await converter?.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined)
    await converter?.end()
  })

  it('matches the foreign key the sales migration declares on quote lines', async () => {
    const { rows } = await converter.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'sales_quote_lines_quote_id_foreign' and connamespace = 'public'::regnamespace`,
    )
    if (rows.length === 0) return
    expect(rows[0].definition).toMatch(/^FOREIGN KEY \(quote_id\) REFERENCES (public\.)?sales_quotes\(id\) ON UPDATE CASCADE$/)
  })

  async function convertHoldingQuoteRow(quoteId: string): Promise<{ commit: () => Promise<void> }> {
    await converter.query('begin')
    await converter.query('select id from sales_quotes where id = $1 for update', [quoteId])
    await converter.query('insert into sales_orders (id) values ($1)', [quoteId])
    await converter.query(
      'insert into sales_order_lines (id, order_id, configuration) select id, quote_id, configuration from sales_quote_lines where quote_id = $1',
      [quoteId],
    )
    await converter.query('delete from sales_quote_lines where quote_id = $1', [quoteId])
    await converter.query('delete from sales_quotes where id = $1', [quoteId])
    return { commit: async () => void (await converter.query('commit')) }
  }

  async function configuredOrderLines(orderId: string): Promise<number> {
    const { rows } = await converter.query<{ count: string }>(
      `select count(*) from sales_order_lines where order_id = $1 and configuration ? 'productConfigurator'`,
      [orderId],
    )
    return Number(rows[0].count)
  }

  it('makes a concurrent configured insert fail on the foreign key, with nothing on the order', async () => {
    const quoteId = randomUUID()
    await converter.query('insert into sales_quotes (id) values ($1)', [quoteId])
    const conversion = await convertHoldingQuoteRow(quoteId)

    await writer.query('begin')
    const insert = writer
      .query('insert into sales_quote_lines (id, quote_id, configuration) values ($1, $2, $3)', [
        randomUUID(),
        quoteId,
        JSON.stringify({ productConfigurator: { snapshotId: randomUUID() } }),
      ])
      .then(
        () => null,
        (error: { code?: string }) => error.code ?? 'error',
      )
    await new Promise((resolve) => setTimeout(resolve, 200))
    await conversion.commit()
    expect(await insert).toBe('23503')
    await writer.query('rollback')
    expect(await configuredOrderLines(quoteId)).toBe(0)
  })

  it('makes the sales parent row lock find no quote after the conversion commits (sales answers 404)', async () => {
    const quoteId = randomUUID()
    await converter.query('insert into sales_quotes (id) values ($1)', [quoteId])
    const conversion = await convertHoldingQuoteRow(quoteId)

    await writer.query('begin')
    const locked = writer.query('select id from sales_quotes where id = $1 for no key update', [quoteId])
    await new Promise((resolve) => setTimeout(resolve, 200))
    await conversion.commit()
    expect((await locked).rowCount).toBe(0)
    await writer.query('rollback')
    expect(await configuredOrderLines(quoteId)).toBe(0)
  })

  it('copies a configured line committed before the conversion to the order', async () => {
    const quoteId = randomUUID()
    await converter.query('insert into sales_quotes (id) values ($1)', [quoteId])
    await writer.query('insert into sales_quote_lines (id, quote_id, configuration) values ($1, $2, $3)', [
      randomUUID(),
      quoteId,
      JSON.stringify({ productConfigurator: { snapshotId: randomUUID() } }),
    ])
    const conversion = await convertHoldingQuoteRow(quoteId)
    await conversion.commit()
    expect(await configuredOrderLines(quoteId)).toBe(1)
  })
})
