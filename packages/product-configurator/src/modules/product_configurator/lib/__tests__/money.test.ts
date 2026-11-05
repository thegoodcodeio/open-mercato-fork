import {
  canonicalDecimal,
  currencyExponent,
  divideHalfUp,
  formatScaled,
  parseDecimal,
  rescale,
  roundNumber,
  toScaled,
  toScaledExact,
} from '../money'

describe('money', () => {
  it('parses decimal strings and numbers, including exponent notation', () => {
    expect(parseDecimal('12.3450')).toEqual({ coefficient: 123450n, scale: 4 })
    expect(parseDecimal(-0.5)).toEqual({ coefficient: -5n, scale: 1 })
    expect(parseDecimal(1e-7)).toEqual({ coefficient: 1n, scale: 7 })
    expect(parseDecimal('2e3')).toEqual({ coefficient: 2000n, scale: 0 })
    expect(() => parseDecimal('1,5')).toThrow('[internal]')
    expect(() => parseDecimal(Number.NaN)).toThrow('[internal]')
  })

  it('rounds half-up away from zero', () => {
    expect(divideHalfUp(25n, 10n)).toBe(3n)
    expect(divideHalfUp(24n, 10n)).toBe(2n)
    expect(divideHalfUp(-25n, 10n)).toBe(-3n)
    expect(rescale(1005n, 3, 2)).toBe(101n)
    expect(toScaled(1.005, 2)).toBe(101n)
    expect(toScaled('0.0049', 2)).toBe(0n)
    expect(toScaled('0.005', 2)).toBe(1n)
    expect(roundNumber(10 / 3, 6)).toBe(3.333333)
    expect(roundNumber(0.1 + 0.2, 6)).toBe(0.3)
  })

  it('keeps catalog precision exactly and rejects extra precision', () => {
    expect(toScaledExact('12.345600', 4)).toBe(123456n)
    expect(toScaledExact('7', 4)).toBe(70000n)
    expect(() => toScaledExact('0.00001', 4)).toThrow('more than 4 decimals')
  })

  it('formats scaled integers at fixed and canonical precision', () => {
    expect(formatScaled(123450n, 2)).toBe('1234.50')
    expect(formatScaled(5n, 2)).toBe('0.05')
    expect(formatScaled(-5n, 3)).toBe('-0.005')
    expect(formatScaled(1235n, 0)).toBe('1235')
    expect(canonicalDecimal(3250000n, 6)).toBe('3.25')
    expect(canonicalDecimal(1000000n, 6)).toBe('1')
    expect(canonicalDecimal(0n, 6)).toBe('0')
    expect(canonicalDecimal(10000000n, 6)).toBe('10')
  })

  it('reads the currency exponent from Intl', () => {
    expect(currencyExponent('EUR')).toBe(2)
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('KWD')).toBe(3)
    expect(currencyExponent('BHD')).toBe(3)
  })
})
