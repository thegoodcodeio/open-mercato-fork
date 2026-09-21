import {
  clampDateToMonth,
  getDaysInMonth,
  getMonday,
  getWeekAnchor,
  normalizeLocalDate,
} from '../dateAnchor'

function localParts(date: Date): [number, number, number, number, number, number, number] {
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ]
}

describe('dateAnchor', () => {
  describe('clampDateToMonth', () => {
    it('clamps 31 January to 28 February in a non-leap year', () => {
      expect(localParts(clampDateToMonth(new Date(2026, 0, 31), 2026, 1))).toEqual([2026, 1, 28, 0, 0, 0, 0])
    })

    it('clamps 31 January to 29 February in a leap year', () => {
      expect(localParts(clampDateToMonth(new Date(2028, 0, 31), 2028, 1))).toEqual([2028, 1, 29, 0, 0, 0, 0])
    })

    it('clamps 30 March back to 28 February', () => {
      expect(localParts(clampDateToMonth(new Date(2026, 2, 30), 2026, 1))).toEqual([2026, 1, 28, 0, 0, 0, 0])
    })

    it('carries 31 December into January of the next year without clamping', () => {
      expect(localParts(clampDateToMonth(new Date(2026, 11, 31), 2027, 0))).toEqual([2027, 0, 31, 0, 0, 0, 0])
    })

    it('keeps the day when the target month is long enough', () => {
      expect(localParts(clampDateToMonth(new Date(2026, 1, 15, 17, 45), 2026, 2))).toEqual([2026, 2, 15, 0, 0, 0, 0])
    })
  })

  describe('normalizeLocalDate', () => {
    it('zeroes the time without shifting the local day', () => {
      const lateEvening = new Date(2026, 2, 29, 23, 59, 59, 999)
      expect(localParts(normalizeLocalDate(lateEvening))).toEqual([2026, 2, 29, 0, 0, 0, 0])
    })

    it('does not mutate its input', () => {
      const input = new Date(2026, 8, 16, 14, 30)
      normalizeLocalDate(input)
      expect(input.getHours()).toBe(14)
    })
  })

  describe('getMonday', () => {
    it('returns the previous Monday for a Sunday', () => {
      expect(localParts(getMonday(new Date(2026, 8, 20, 12)))).toEqual([2026, 8, 14, 0, 0, 0, 0])
    })

    it('returns the same day for a Monday', () => {
      expect(localParts(getMonday(new Date(2026, 8, 14, 8)))).toEqual([2026, 8, 14, 0, 0, 0, 0])
    })

    it('crosses a month boundary', () => {
      expect(localParts(getMonday(new Date(2026, 2, 1)))).toEqual([2026, 1, 23, 0, 0, 0, 0])
    })
  })

  describe('getWeekAnchor', () => {
    it('anchors a Monday to that week’s Thursday', () => {
      expect(localParts(getWeekAnchor(new Date(2026, 8, 14)))).toEqual([2026, 8, 17, 0, 0, 0, 0])
    })

    it('anchors any day of the week to the same Thursday', () => {
      expect(localParts(getWeekAnchor(new Date(2026, 8, 20, 22)))).toEqual([2026, 8, 17, 0, 0, 0, 0])
    })

    it('anchors a week split across months to the month holding its Thursday', () => {
      expect(localParts(getWeekAnchor(new Date(2026, 5, 29)))).toEqual([2026, 6, 2, 0, 0, 0, 0])
    })
  })

  it('counts the days of February in leap and non-leap years', () => {
    expect(getDaysInMonth(2026, 1)).toBe(28)
    expect(getDaysInMonth(2028, 1)).toBe(29)
  })
})
