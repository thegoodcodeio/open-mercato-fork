"use client"

import * as React from 'react'

/** Rows per page of the lookup row editor; a lookup holds at most 1000 rows. */
export const LOOKUP_ROWS_PAGE_SIZE = 50

/** Shows the search field above this many rows. */
export const LOOKUP_ROWS_SEARCH_FROM = 10

export type RowWindow<Row> = {
  query: string
  setQuery: (query: string) => void
  page: number
  setPage: (page: number) => void
  /** Rows of the current page with their index in the full list. */
  visible: Array<{ row: Row; index: number }>
  /** Rows that pass the search. */
  total: number
}

/**
 * Search plus pagination over the rows of one lookup, so a 1000-row table renders one page of inputs.
 * `focus` (the first row with an error, a new object per failed save) clears the search and moves to its page.
 */
export function useRowWindow<Row>(
  rows: readonly Row[],
  matchesQuery: (row: Row, query: string) => boolean,
  focus: { index: number } | null,
): RowWindow<Row> {
  const [query, setQueryState] = React.useState('')
  const [page, setPage] = React.useState(1)

  React.useEffect(() => {
    if (!focus) return
    setQueryState('')
    setPage(Math.floor(focus.index / LOOKUP_ROWS_PAGE_SIZE) + 1)
  }, [focus])

  const normalized = query.trim().toLowerCase()
  const filtered = rows.flatMap((row, index) => (normalized === '' || matchesQuery(row, normalized) ? [{ row, index }] : []))
  const lastPage = Math.max(1, Math.ceil(filtered.length / LOOKUP_ROWS_PAGE_SIZE))
  const current = Math.min(page, lastPage)
  const start = (current - 1) * LOOKUP_ROWS_PAGE_SIZE

  return {
    query,
    setQuery: (next) => {
      setQueryState(next)
      setPage(1)
    },
    page: current,
    setPage,
    visible: filtered.slice(start, start + LOOKUP_ROWS_PAGE_SIZE),
    total: filtered.length,
  }
}
