/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConfigurationSession } from '../../data/entities'
import type { ConfigurationResult } from '../evaluation'
import type { FinaliseSession } from '../finalise'
import { createFinaliseStore } from '../finaliseStore'

const findOneWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: jest.fn(),
}))

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const CONFIRMED_HASH = 'b'.repeat(64)

const session: FinaliseSession = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: SCOPE.tenantId,
  organizationId: SCOPE.organizationId,
  quoteId: '33333333-3333-4333-8333-333333333333',
  modelVersionId: '66666666-6666-4666-8666-666666666666',
  revision: 3,
  status: 'finalising',
  selections: { size: 's' },
  evaluation: { hash: 'a'.repeat(64) },
  migration: null,
}

describe('createFinaliseStore.writeSnapshot', () => {
  it('stores the result it snapshots as the session evaluation, in the same transaction', async () => {
    const locked = { id: session.id, status: 'finalising', evaluation: session.evaluation }
    findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => (entity === ConfigurationSession ? locked : null))
    const flushed: Array<Record<string, unknown> | null | undefined> = []
    const trx = {
      remove: jest.fn(),
      persist: jest.fn(),
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'snapshot-1', ...data }),
      flush: jest.fn(async () => {
        flushed.push(locked.evaluation)
      }),
    }
    const em = { fork: () => ({ transactional: (run: (manager: typeof trx) => Promise<unknown>) => run(trx) }) }
    const result = { hash: CONFIRMED_HASH, netPrice: '120.00', selections: {}, visibility: {} } as unknown as ConfigurationResult

    const snapshot = await createFinaliseStore(em as unknown as EntityManager, SCOPE).writeSnapshot(session, {
      result,
      modelVersionHash: 'f'.repeat(64),
      modelTitle: 'Pump',
      productId: '77777777-7777-4777-8777-777777777777',
      taxRateId: null,
    })

    expect(snapshot).toMatchObject({ id: 'snapshot-1', hash: CONFIRMED_HASH })
    expect(locked.evaluation).toBe(result)
    expect(flushed).toEqual([result])
  })
})
