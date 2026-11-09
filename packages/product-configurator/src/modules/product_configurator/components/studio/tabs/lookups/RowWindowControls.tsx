"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Pagination } from '@open-mercato/ui/primitives/pagination'
import { SearchInput } from '@open-mercato/ui/primitives/search-input'
import { TableCell, TableRow } from '@open-mercato/ui/primitives/table'
import { LOOKUP_ROWS_PAGE_SIZE, LOOKUP_ROWS_SEARCH_FROM, type RowWindow } from './useRowWindow'

export function RowSearch<Row>({ rowWindow, rowCount }: { rowWindow: RowWindow<Row>; rowCount: number }) {
  const t = useT()
  if (rowCount <= LOOKUP_ROWS_SEARCH_FROM) return null
  return (
    <SearchInput
      size="sm"
      className="max-w-xs"
      value={rowWindow.query}
      onChange={rowWindow.setQuery}
      placeholder={t('product_configurator.studio.lookups.searchRows', 'Find a row')}
      aria-label={t('product_configurator.studio.lookups.searchRows', 'Find a row')}
    />
  )
}

export function RowPager<Row>({ rowWindow }: { rowWindow: RowWindow<Row> }) {
  const t = useT()
  if (rowWindow.total <= LOOKUP_ROWS_PAGE_SIZE) return null
  return (
    <Pagination
      page={rowWindow.page}
      pageSize={LOOKUP_ROWS_PAGE_SIZE}
      total={rowWindow.total}
      onPageChange={rowWindow.setPage}
      aria-label={t('product_configurator.studio.lookups.rowPages', 'Lookup row pages')}
    />
  )
}

export function NoMatchingRows<Row>({ rowWindow, colSpan }: { rowWindow: RowWindow<Row>; colSpan: number }) {
  const t = useT()
  if (rowWindow.visible.length > 0) return null
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-sm text-muted-foreground">
        {rowWindow.query
          ? t('product_configurator.studio.lookups.noMatchingRows', 'No rows match the search.')
          : t('product_configurator.studio.lookups.noRows', 'No rows yet.')}
      </TableCell>
    </TableRow>
  )
}
