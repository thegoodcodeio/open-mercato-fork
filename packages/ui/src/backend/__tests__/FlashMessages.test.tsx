import * as React from 'react'
import { act, screen } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { FlashHostBoundary, FlashMessages, flash } from '../FlashMessages'
import { FrontendLayout } from '../../frontend/Layout'

function setReferrer(value: string) {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value,
  })
}

describe('FlashMessages', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    window.history.replaceState({}, '', 'http://localhost/backend')
    setReferrer('')
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    window.history.replaceState({}, '', 'http://localhost/backend')
    setReferrer('')
  })

  it('auto-dismisses URL-based flashes after stripping query params', () => {
    window.history.replaceState({}, '', 'http://localhost/backend/checkout/pay-links?flash=Saved&type=success')

    renderWithProviders(<FlashMessages />)

    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(window.location.search).toBe('')

    act(() => {
      jest.advanceTimersByTime(3000)
    })

    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('honors same-origin referrer flashes', () => {
    setReferrer('http://localhost/backend/checkout/templates')
    window.history.replaceState({}, '', 'http://localhost/backend/checkout/pay-links?flash=Saved&type=success')

    renderWithProviders(<FlashMessages />)

    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('suppresses cross-origin referrer flashes but still strips the params', () => {
    setReferrer('https://attacker.example.com/phish')
    window.history.replaceState(
      {},
      '',
      'http://localhost/backend/dashboard?flash=Your+account+was+suspended&type=error',
    )

    renderWithProviders(<FlashMessages />)

    expect(screen.queryByText('Your account was suspended')).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('falls back to a safe kind when the type param is not an allowed FlashKind', () => {
    window.history.replaceState(
      {},
      '',
      'http://localhost/backend/dashboard?flash=Saved&type=javascript',
    )

    renderWithProviders(<FlashMessages />)

    expect(screen.getByText('Saved')).toBeInTheDocument()
    const badge = document.querySelector('[data-slot="alert-icon-badge"]')
    expect(badge?.getAttribute('data-status')).toBe('success')
  })

  it('renders one banner when a nested shell mounts a second host inside the boundary', () => {
    renderWithProviders(
      <>
        <FlashMessages />
        <FlashHostBoundary>
          <FlashMessages />
        </FlashHostBoundary>
      </>,
    )

    act(() => {
      flash('Saved once', 'success')
    })

    expect(screen.getAllByText('Saved once')).toHaveLength(1)

    act(() => {
      jest.advanceTimersByTime(3000)
    })
  })

  it('renders one banner for a host nested inside FrontendLayout, as AppShell is', () => {
    renderWithProviders(
      <FrontendLayout>
        <FlashMessages />
      </FrontendLayout>,
    )

    act(() => {
      flash('Saved once', 'success')
    })

    expect(screen.getAllByText('Saved once')).toHaveLength(1)

    act(() => {
      jest.advanceTimersByTime(3000)
    })
  })

  it('still renders a host mounted without any boundary above it', () => {
    renderWithProviders(<FlashMessages />)

    act(() => {
      flash('Standalone shell', 'success')
    })

    expect(screen.getAllByText('Standalone shell')).toHaveLength(1)

    act(() => {
      jest.advanceTimersByTime(3000)
    })
  })

  it('auto-dismisses programmatic flashes', () => {
    renderWithProviders(<FlashMessages />)

    act(() => {
      flash('Pay link published', 'success')
    })

    expect(screen.getByText('Pay link published')).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(3000)
    })

    expect(screen.queryByText('Pay link published')).not.toBeInTheDocument()
  })
})
