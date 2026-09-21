export function getMonday(date: Date): Date {
  const monday = new Date(date)
  const day = monday.getDay()
  const diff = day === 0 ? -6 : 1 - day
  monday.setDate(monday.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export function normalizeLocalDate(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

/** Moves `baseDate` into the given month, keeping its day unless the month is shorter. */
export function clampDateToMonth(baseDate: Date, year: number, month: number): Date {
  const clampedDay = Math.min(baseDate.getDate(), getDaysInMonth(year, month))
  return normalizeLocalDate(new Date(year, month, clampedDay))
}

/**
 * The date a picked week is remembered by: its Thursday. A Thursday always falls in
 * the month that holds most of the week, so switching to Monthly lands there.
 */
export function getWeekAnchor(date: Date): Date {
  const anchor = getMonday(date)
  anchor.setDate(anchor.getDate() + 3)
  return normalizeLocalDate(anchor)
}
