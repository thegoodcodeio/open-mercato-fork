import type { SelectionValue } from '../data/validators'

export type Selections = Record<string, SelectionValue>

const NUMERIC_STRING = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export function toFiniteNumber(value: SelectionValue | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!NUMERIC_STRING.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function selectionKey(value: SelectionValue | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

export function sortByOrder<Item extends { order: number }>(items: readonly Item[]): Item[] {
  return [...items].sort((left, right) => left.order - right.order)
}
