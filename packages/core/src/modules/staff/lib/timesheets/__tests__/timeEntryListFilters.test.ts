import { buildTimeEntryListFilters } from '../timeEntryListFilters'

/**
 * Asserting the filter MAP alone is what let the original #3717 fix ship broken:
 * `{ $ne: null }` looks correct as a data structure, but the query engine renders
 * it as SQL `!= NULL`, which is never true. These helpers mirror the engine's
 * operator dispatch (`packages/core/src/modules/query_index/lib/engine.ts` —
 * `case 'ne'` → `!=`, bare value → `=`, `case 'exists'` → `is not null`/`is null`)
 * so a null-comparison regression fails here instead of only in the browser.
 */
type NullSemantics = 'IS NOT NULL' | 'IS NULL' | 'NEVER MATCHES'

function nullSemanticsOf(filter: unknown): NullSemantics {
  if (filter !== null && typeof filter === 'object' && !Array.isArray(filter)) {
    const entries = Object.entries(filter as Record<string, unknown>)
    if (entries.length === 1) {
      const [op, value] = entries[0]
      if (op === '$exists') return value ? 'IS NOT NULL' : 'IS NULL'
      // `$ne: null` → `!= NULL`, `$eq: null` → `= NULL`: UNKNOWN, never true.
      if ((op === '$ne' || op === '$eq') && value === null) return 'NEVER MATCHES'
    }
  }
  // A bare `null` value is dispatched as `eq` → `= NULL`.
  if (filter === null) return 'NEVER MATCHES'
  return 'IS NOT NULL'
}

describe('buildTimeEntryListFilters — running filter (issue #3717)', () => {
  it('matches the open timer regardless of date when running=true', () => {
    const filters = buildTimeEntryListFilters({ staffMemberId: 'staff-1', running: 'true' })

    expect(filters.started_at).toEqual({ $exists: true })
    expect(filters.ended_at).toEqual({ $exists: false })
    // A running lookup must NOT scope by date — an overnight timer is off "today".
    expect(filters.date).toBeUndefined()
    expect(filters.staff_member_id).toBe('staff-1')
  })

  it('renders as IS NOT NULL / IS NULL, never a null equality comparison', () => {
    const filters = buildTimeEntryListFilters({ staffMemberId: 'staff-1', running: 'true' })

    // The regression: both sides silently became `NEVER MATCHES`, so the
    // TimerBar could not see any running timer and never showed Stop.
    expect(nullSemanticsOf(filters.started_at)).toBe('IS NOT NULL')
    expect(nullSemanticsOf(filters.ended_at)).toBe('IS NULL')
  })

  it('does not apply the running filter when running is absent or false', () => {
    expect(buildTimeEntryListFilters({ staffMemberId: 'staff-1' }).started_at).toBeUndefined()
    expect(buildTimeEntryListFilters({ staffMemberId: 'staff-1', running: 'false' }).started_at).toBeUndefined()
    expect(buildTimeEntryListFilters({ staffMemberId: 'staff-1', running: 'false' }).ended_at).toBeUndefined()
  })

  it('keeps the date-window filter intact for the historical list view', () => {
    const filters = buildTimeEntryListFilters({ from: '2026-06-30', to: '2026-06-30' })

    expect(filters.date).toEqual({ $gte: '2026-06-30', $lte: '2026-06-30' })
    expect(filters.started_at).toBeUndefined()
    expect(filters.ended_at).toBeUndefined()
  })

  it('can combine a running lookup with a project filter', () => {
    const filters = buildTimeEntryListFilters({ running: 'true', projectId: 'project-9' })

    expect(filters.started_at).toEqual({ $exists: true })
    expect(filters.ended_at).toEqual({ $exists: false })
    expect(filters.time_project_id).toBe('project-9')
  })

  it('parses id lists and ignores blank entries', () => {
    const filters = buildTimeEntryListFilters({ ids: 'a, ,b' })
    expect(filters.id).toEqual({ $in: ['a', 'b'] })
  })
})
