/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { dismissRecordConflict, getRecordConflictForTest } from '@open-mercato/ui/backend/conflicts'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { build } from '../../../lib/__tests__/fixtures'
import enDict from '../../../i18n/en.json'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

type Call = { url: string; init?: RequestInit; headers: Record<string, string> }

const calls: Call[] = []
let scopedHeaders: Record<string, string> = {}
const apiCallMock = jest.fn()
const apiCallOrThrowMock = jest.fn()
const confirmMock = jest.fn(async () => true)
const flashMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (url: string, init?: RequestInit) => apiCallMock(url, init),
  apiCallOrThrow: (url: string, init?: RequestInit) => {
    calls.push({ url, init, headers: { ...scopedHeaders } })
    return apiCallOrThrowMock(url, init)
  },
  withScopedApiRequestHeaders: async <T,>(headers: Record<string, string>, run: () => Promise<T>) => {
    const previous = scopedHeaders
    scopedHeaders = { ...previous, ...headers }
    try {
      return await run()
    } finally {
      scopedHeaders = previous
    }
  },
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => {
  const { surfaceRecordConflict } = jest.requireActual('@open-mercato/ui/backend/conflicts')
  return {
    useGuardedMutation: () => ({
      runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => {
        try {
          return await operation()
        } catch (error) {
          surfaceRecordConflict(error, (_key: string, fallback?: string) => fallback ?? '')
          throw error
        }
      },
      retryLastMutation: async () => false,
    }),
  }
})

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, ConfirmDialogElement: null }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({ DataTable: () => null }))

jest.mock('../tabs/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-tab" /> }))

import { ModelStudio } from '../ModelStudio'

const MODEL_ID = '11111111-1111-4111-8111-111111111111'
const FIRST_TOKEN = '2026-11-05T10:00:00.000Z'

function modelPayload(updatedAt = FIRST_TOKEN, latestVersion: { id: string; version: number; hash: string; publishedAt: string } | null = null) {
  return {
    items: [
      {
        id: MODEL_ID,
        title: 'Pump',
        modelKey: 'pump',
        productId: '22222222-2222-4222-8222-222222222222',
        currencyCode: 'EUR',
        latestVersion,
        hasUnpublishedChanges: false,
        updatedAt,
        draftDefinition: build(),
      },
    ],
  }
}

function httpError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error ?? 'Request failed')), { status, ...body })
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name })
}

async function renderStudio() {
  renderWithProviders(<ModelStudio modelId={MODEL_ID} />, { dict: enDict })
  await screen.findByTestId('model-studio')
}

async function editDraftThroughJson() {
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced (JSON)' }))
  const textarea = await screen.findByLabelText('Definition (JSON)')
  const edited = { ...build(), fixedSpecification: [] }
  fireEvent.change(textarea, { target: { value: JSON.stringify(edited) } })
  fireEvent.click(button('Apply to draft'))
}

beforeEach(() => {
  calls.length = 0
  scopedHeaders = {}
  apiCallMock.mockReset()
  apiCallOrThrowMock.mockReset()
  confirmMock.mockClear()
  flashMock.mockClear()
  dismissRecordConflict()
  apiCallMock.mockImplementation(async (url: string) =>
    url.startsWith('/api/product_configurator/models')
      ? { ok: true, status: 200, result: modelPayload() }
      : { ok: false, status: 403, result: null },
  )
})

describe('ModelStudio', () => {
  it('shows a not-found state for a missing model', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 404, result: null })
    renderWithProviders(<ModelStudio modelId={MODEL_ID} />, { dict: enDict })
    expect(await screen.findByText('Configuration model not found')).toBeTruthy()
  })

  it('enables Save only with unsaved edits, and Validate and Publish only without them', async () => {
    await renderStudio()
    expect(button('Save draft').disabled).toBe(true)
    expect(button('Validate').disabled).toBe(false)
    expect(button('Publish').disabled).toBe(false)

    await editDraftThroughJson()

    expect(button('Save draft').disabled).toBe(false)
    expect(button('Validate').disabled).toBe(true)
    expect(button('Publish').disabled).toBe(true)
    expect(screen.getByText('Unsaved changes: save first, Validate and Publish use the saved draft.')).toBeTruthy()
  })

  it('discard asks first and restores the saved draft', async () => {
    await renderStudio()
    await editDraftThroughJson()
    fireEvent.click(button('Discard unsaved changes'))
    await waitFor(() => expect(button('Save draft').disabled).toBe(true))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Discard unsaved changes' })).toBeNull()
  })

  it('saves the draft with the lock header and uses the returned updatedAt for publish', async () => {
    apiCallOrThrowMock.mockImplementation(async (url: string) =>
      url.endsWith('/publish')
        ? { ok: true, status: 200, result: { modelVersionId: 'v1', version: 1, hash: 'h', updatedAt: '2026-11-05T12:00:00.000Z' } }
        : { ok: true, status: 200, result: { id: MODEL_ID, updatedAt: '2026-11-05T11:00:00.000Z', draftHash: 'h' } },
    )
    await renderStudio()
    await editDraftThroughJson()
    fireEvent.click(button('Save draft'))
    await waitFor(() => expect(button('Validate').disabled).toBe(false))

    const save = calls[0]
    expect(save.init?.method).toBe('PUT')
    expect(save.headers[OPTIMISTIC_LOCK_HEADER_NAME]).toBe(FIRST_TOKEN)
    expect(JSON.parse(String(save.init?.body)).draftDefinition.fixedSpecification).toEqual([])

    fireEvent.click(button('Publish'))
    expect(await screen.findByTestId('studio-published-alert')).toBeTruthy()
    expect(calls[1].headers[OPTIMISTIC_LOCK_HEADER_NAME]).toBe('2026-11-05T11:00:00.000Z')
    expect(screen.getByText('Published v1')).toBeTruthy()
    expect(button('Publish').disabled).toBe(true)
  })

  it('shows the publish validation report inline with links to the rows', async () => {
    apiCallOrThrowMock.mockRejectedValue(
      httpError(422, {
        code: 'validation_failed',
        report: {
          ok: false,
          issues: [{ check: 'default_valid', code: 'default_not_an_option', params: { featureKey: 'motor', value: 'x' }, refs: [{ kind: 'feature', key: 'motor' }] }],
        },
      }),
    )
    await renderStudio()
    fireEvent.click(button('Publish'))
    expect(await screen.findByText('Cannot publish: 1 problem')).toBeTruthy()
    expect(screen.getByText('The default x of Motor (motor) is not one of its options.')).toBeTruthy()
    fireEvent.click(button('Features › Motor (motor)'))
    expect(screen.getByRole('tab', { name: /Features/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('on a 409 shows the conflict bar whose refresh asks before replacing unsaved edits', async () => {
    apiCallOrThrowMock.mockRejectedValue(
      httpError(409, {
        code: 'optimistic_lock_conflict',
        error: 'record_modified',
        currentUpdatedAt: '2026-11-05T10:30:00.000Z',
        expectedUpdatedAt: FIRST_TOKEN,
      }),
    )
    await renderStudio()
    await editDraftThroughJson()
    fireEvent.click(button('Save draft'))

    expect(await screen.findByTestId('studio-conflict-alert')).toBeTruthy()
    const conflict = getRecordConflictForTest()
    expect(conflict?.onRefresh).toBeInstanceOf(Function)

    apiCallMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/product_configurator/models')
        ? { ok: true, status: 200, result: modelPayload('2026-11-05T10:30:00.000Z') }
        : { ok: false, status: 403, result: null },
    )
    act(() => conflict?.onRefresh?.())
    expect(await screen.findByText('Refresh and lose your changes?')).toBeTruthy()
    expect(button('Copy my draft (JSON)')).toBeTruthy()

    fireEvent.click(button('Refresh'))
    await waitFor(() => expect(screen.queryByTestId('studio-conflict-alert')).toBeNull())
    expect(button('Save draft').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Discard unsaved changes' })).toBeNull()
  })

  it('shows a deleted-model state with a draft copy when the refresh finds no model', async () => {
    apiCallOrThrowMock.mockRejectedValue(
      httpError(409, {
        code: 'optimistic_lock_conflict',
        error: 'record_modified',
        currentUpdatedAt: '2026-11-05T10:30:00.000Z',
        expectedUpdatedAt: FIRST_TOKEN,
      }),
    )
    await renderStudio()
    await editDraftThroughJson()
    fireEvent.click(button('Save draft'))
    expect(await screen.findByTestId('studio-conflict-alert')).toBeTruthy()

    apiCallMock.mockImplementation(async () => ({ ok: false, status: 404, result: null }))
    fireEvent.click(button('Refresh…'))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))

    const missing = await screen.findByTestId('studio-missing-alert')
    expect(missing.textContent).toContain('Configuration model not found')
    expect(screen.queryByTestId('studio-conflict-alert')).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to models' }).getAttribute('href')).toBe('/backend/product_configurator/models')
    expect(button('Copy my draft (JSON)')).toBeTruthy()
    expect(button('Copy my draft (JSON)').disabled).toBe(false)
    expect(button('Save draft').disabled).toBe(true)
    expect(button('Validate').disabled).toBe(true)
    expect(button('Publish').disabled).toBe(true)
    expect((screen.getByLabelText('Definition (JSON)') as HTMLTextAreaElement).readOnly).toBe(true)
    expect(screen.getByTestId('model-studio')).toBeTruthy()
    expect(flashMock).not.toHaveBeenCalledWith(expect.anything(), 'error')
    expect(getRecordConflictForTest()).toBeNull()
  })
})
