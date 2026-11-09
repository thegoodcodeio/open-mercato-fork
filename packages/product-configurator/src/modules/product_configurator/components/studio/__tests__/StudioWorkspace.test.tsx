/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { dismissRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { build } from '../../../lib/__tests__/fixtures'
import enDict from '../../../i18n/en.json'
import type { StudioTabProps } from '../tabs/types'

Object.assign(globalThis, { TextEncoder })

type Call = { url: string; init?: RequestInit; headers: Record<string, string> }
type MutationContext = { retryLastMutation: () => Promise<boolean> }

const calls: Call[] = []
let scopedHeaders: Record<string, string> = {}
let lastContext: MutationContext | null = null
const apiCallMock = jest.fn()
const apiCallOrThrowMock = jest.fn()
const confirmMock = jest.fn(async (_options?: { title?: string }) => true)
const flashMock = jest.fn()
const writeTextMock = jest.fn(async (_text: string) => undefined)

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

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation, context }: { operation: () => Promise<unknown>; context: MutationContext }) => {
      lastContext = context
      return operation()
    },
    retryLastMutation: async () => false,
  }),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, ConfirmDialogElement: null }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({ DataTable: () => null }))

jest.mock('../tabs/OverviewTab', () => ({
  OverviewTab: ({ onDirtyChange }: StudioTabProps) => (
    <div data-testid="overview-tab">
      <button type="button" onClick={() => onDirtyChange?.(true)}>
        edit title
      </button>
      <button type="button" onClick={() => onDirtyChange?.(false)}>
        reset title
      </button>
    </div>
  ),
}))

import { ModelStudio } from '../ModelStudio'

const MODEL_ID = '11111111-1111-4111-8111-111111111111'
const FIRST_TOKEN = '2026-11-05T10:00:00.000Z'
const SAVED_TOKEN = '2026-11-05T11:00:00.000Z'

const dict: Record<string, string> = {
  ...enDict,
  'product_configurator.studio.report.cannotPublishCount.one': 'Cannot publish: {count} problem',
  'product_configurator.studio.report.cannotPublishCount.other': 'Cannot publish: {count} problems',
}

function modelPayload() {
  return {
    items: [
      {
        id: MODEL_ID,
        title: 'Pump',
        modelKey: 'pump',
        productId: '22222222-2222-4222-8222-222222222222',
        currencyCode: 'EUR',
        latestVersion: null,
        hasUnpublishedChanges: false,
        updatedAt: FIRST_TOKEN,
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

function leaveIsBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

async function renderStudio() {
  renderWithProviders(<ModelStudio modelId={MODEL_ID} />, { dict })
  await screen.findByTestId('model-studio')
}

async function openJsonEditor(): Promise<HTMLTextAreaElement> {
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced (JSON)' }))
  const textarea = await screen.findByLabelText('Definition (JSON)')
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('JSON editor is not a textarea')
  return textarea
}

async function applyJsonEdit() {
  const textarea = await openJsonEditor()
  fireEvent.change(textarea, { target: { value: JSON.stringify({ ...build(), fixedSpecification: [] }) } })
  fireEvent.click(button('Apply to draft'))
  return textarea
}

beforeEach(() => {
  calls.length = 0
  scopedHeaders = {}
  lastContext = null
  apiCallMock.mockReset()
  apiCallOrThrowMock.mockReset()
  confirmMock.mockReset()
  confirmMock.mockImplementation(async () => true)
  flashMock.mockClear()
  writeTextMock.mockClear()
  Object.assign(navigator, { clipboard: { writeText: writeTextMock } })
  dismissRecordConflict()
  apiCallMock.mockImplementation(async () => ({ ok: true, status: 200, result: modelPayload() }))
})

describe('StudioWorkspace', () => {
  it('a retried save runs the whole save lifecycle and the next write uses the returned lock token', async () => {
    apiCallOrThrowMock.mockRejectedValueOnce(httpError(423, { error: 'Locked by another user' }))
    await renderStudio()
    await applyJsonEdit()
    fireEvent.click(button('Save draft'))
    await waitFor(() => expect(flashMock).toHaveBeenCalledWith('Locked by another user', 'error'))
    expect(button('Save draft').disabled).toBe(false)

    apiCallOrThrowMock.mockImplementation(async (url: string) =>
      url.endsWith('/publish')
        ? { ok: true, status: 200, result: { modelVersionId: 'v1', version: 1, hash: 'h', updatedAt: '2026-11-05T12:00:00.000Z' } }
        : { ok: true, status: 200, result: { id: MODEL_ID, updatedAt: SAVED_TOKEN, draftHash: 'h' } },
    )
    let retried: boolean | undefined
    await act(async () => {
      retried = await lastContext?.retryLastMutation()
    })
    expect(retried).toBe(true)
    expect(flashMock).toHaveBeenCalledWith('Draft saved.', 'success')
    expect(button('Save draft').disabled).toBe(true)
    expect(calls[1].headers[OPTIMISTIC_LOCK_HEADER_NAME]).toBe(FIRST_TOKEN)

    fireEvent.click(button('Publish'))
    expect(await screen.findByTestId('studio-published-alert')).toBeTruthy()
    expect(calls[2].headers[OPTIMISTIC_LOCK_HEADER_NAME]).toBe(SAVED_TOKEN)
  })

  it('a retried publish shows the published state', async () => {
    apiCallOrThrowMock.mockRejectedValueOnce(httpError(423, { error: 'Locked by another user' }))
    await renderStudio()
    fireEvent.click(button('Publish'))
    await waitFor(() => expect(flashMock).toHaveBeenCalledWith('Locked by another user', 'error'))
    expect(screen.queryByTestId('studio-published-alert')).toBeNull()

    apiCallOrThrowMock.mockResolvedValue({
      ok: true,
      status: 200,
      result: { modelVersionId: 'v1', version: 1, hash: 'h', updatedAt: '2026-11-05T12:00:00.000Z' },
    })
    await act(async () => {
      await lastContext?.retryLastMutation()
    })
    expect(await screen.findByTestId('studio-published-alert')).toBeTruthy()
  })

  it('treats JSON text that is not applied as unsaved, and Save asks before leaving it out', async () => {
    await renderStudio()
    expect(leaveIsBlocked()).toBe(false)
    const textarea = await openJsonEditor()
    fireEvent.change(textarea, { target: { value: '{ "half": ' } })
    expect(screen.getByTestId('studio-json-pending')).toBeTruthy()
    expect(leaveIsBlocked()).toBe(true)

    fireEvent.click(button('Reset text'))
    expect(leaveIsBlocked()).toBe(false)

    await applyJsonEdit()
    fireEvent.change(textarea, { target: { value: '{ "more": ' } })
    confirmMock.mockImplementation(async () => false)
    fireEvent.click(button('Save draft'))
    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save without the text in Advanced (JSON)?' })),
    )
    expect(calls).toHaveLength(0)
  })

  it('copies the text that is not applied instead of the draft', async () => {
    apiCallOrThrowMock.mockRejectedValue(
      httpError(409, { code: 'optimistic_lock_conflict', error: 'record_modified', currentUpdatedAt: SAVED_TOKEN, expectedUpdatedAt: FIRST_TOKEN }),
    )
    await renderStudio()
    const textarea = await applyJsonEdit()
    fireEvent.click(button('Save draft'))
    expect(await screen.findByTestId('studio-conflict-alert')).toBeTruthy()

    fireEvent.change(textarea, { target: { value: '{ "pending": true' } })
    fireEvent.click(button('Copy my draft (JSON)'))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith('{ "pending": true'))
  })

  it('shows translated JSON problems with the raw detail as secondary text', async () => {
    await renderStudio()
    const textarea = await openJsonEditor()
    fireEvent.change(textarea, { target: { value: '{' } })
    fireEvent.click(button('Apply to draft'))
    expect(await screen.findByText('The text is not valid JSON.')).toBeTruthy()

    fireEvent.change(textarea, { target: { value: JSON.stringify({ ...build(), fixedSpecification: 'none' }) } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(await screen.findByText('This value has the wrong type.')).toBeTruthy()
    expect(screen.getByText('fixedSpecification')).toBeTruthy()
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
  })

  it('guards navigation while a tab reports local unsaved edits', async () => {
    await renderStudio()
    fireEvent.click(button('edit title'))
    expect(leaveIsBlocked()).toBe(true)
    expect(screen.getByText('Save or cancel the open editor first.')).toBeTruthy()
    fireEvent.click(button('reset title'))
    expect(leaveIsBlocked()).toBe(false)
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
  })

  it('names the publish report with the plural form of its problem count', async () => {
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
    const title = await screen.findByRole('heading', { name: 'Cannot publish: 1 problem' })
    expect(screen.getByTestId('studio-validation-report').getAttribute('aria-labelledby')).toBe(title.id)
    expect(screen.getByRole('alert').textContent).toBe('Cannot publish: 1 problem')
  })
})
