export const PRICE_SCALE = 4
export const QUANTITY_SCALE = 6

type ParsedDecimal = { coefficient: bigint; scale: number }

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

/** Covers every finite JS number (5e-324 to 1.8e308); a larger exponent would only make BigInt powers explode. */
const MAX_DECIMAL_EXPONENT = 324

/** Longer than any JS number or `numeric(18,4)` text; longer input is refused before any regex runs on it. */
const MAX_DECIMAL_LENGTH = 64

type DecimalParts = { negative: boolean; digits: string; fractionLength: number; exponent: number }

function matchDecimal(input: string | number): DecimalParts {
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new Error(`[internal] product_configurator: non-finite decimal ${input}`)
  }
  const text = String(input)
  if (text.length > MAX_DECIMAL_LENGTH) {
    throw new Error(`[internal] product_configurator: decimal longer than ${MAX_DECIMAL_LENGTH} characters`)
  }
  const match = DECIMAL_PATTERN.exec(text.trim())
  if (!match) throw new Error(`[internal] product_configurator: invalid decimal ${String(input)}`)
  const [, sign, whole, fraction = '', exponent = '0'] = match
  const parsedExponent = Number(exponent)
  if (Math.abs(parsedExponent) > MAX_DECIMAL_EXPONENT) {
    throw new Error(`[internal] product_configurator: decimal exponent out of range ${String(input)}`)
  }
  return { negative: sign === '-', digits: `${whole}${fraction}`, fractionLength: fraction.length, exponent: parsedExponent }
}

export function parseDecimal(input: string | number): ParsedDecimal {
  const { negative, digits, fractionLength, exponent } = matchDecimal(input)
  const unsigned = BigInt(digits)
  const scale = fractionLength - exponent
  const signed = negative ? -unsigned : unsigned
  if (scale >= 0) return { coefficient: signed, scale }
  return { coefficient: signed * 10n ** BigInt(-scale), scale: 0 }
}

/** `digits` x 10^`exponent` with no leading or trailing zero digits; zero is `0e0` without a sign. */
function normalizedDecimal(input: string | number): string {
  const { negative, digits, fractionLength, exponent } = matchDecimal(input)
  const significant = digits.replace(/^0+/, '')
  let end = significant.length
  while (end > 0 && significant[end - 1] === '0') end -= 1
  const trimmed = significant.slice(0, end)
  if (!trimmed) return '0e0'
  const power = exponent - fractionLength + (significant.length - trimmed.length)
  return `${negative ? '-' : ''}${trimmed}e${power}`
}

/** Exact decimal equality at any scale (`1` equals `1.0000`, `1.00004` does not); false for anything that is not a decimal. */
export function sameDecimal(left: string | number, right: string | number): boolean {
  try {
    return normalizedDecimal(left) === normalizedDecimal(right)
  } catch {
    return false
  }
}

export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('[internal] product_configurator: denominator must be positive')
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

export function rescale(value: bigint, fromScale: number, toScale: number): bigint {
  if (toScale >= fromScale) return value * 10n ** BigInt(toScale - fromScale)
  return divideHalfUp(value, 10n ** BigInt(fromScale - toScale))
}

export function toScaled(input: string | number, scale: number): bigint {
  const parsed = parseDecimal(input)
  return rescale(parsed.coefficient, parsed.scale, scale)
}

export function toScaledExact(input: string | number, scale: number): bigint {
  const parsed = parseDecimal(input)
  const scaled = rescale(parsed.coefficient, parsed.scale, scale)
  if (rescale(scaled, scale, parsed.scale) !== parsed.coefficient) {
    throw new Error(`[internal] product_configurator: ${String(input)} has more than ${scale} decimals`)
  }
  return scaled
}

export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale)
  const body = scale > 0 ? `${whole}.${fraction}` : whole
  return negative ? `-${body}` : body
}

export function canonicalDecimal(value: bigint, scale: number): string {
  const fixed = formatScaled(value, scale)
  return scale > 0 ? fixed.replace(/\.?0+$/, '') : fixed
}

export function roundNumber(value: number, decimals: number): number {
  return Number(formatScaled(toScaled(value, decimals), decimals))
}

export function currencyExponent(currencyCode: string): number {
  const { maximumFractionDigits } = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: currencyCode,
  }).resolvedOptions()
  if (maximumFractionDigits === undefined) {
    throw new Error(`[internal] product_configurator: no currency exponent for ${currencyCode}`)
  }
  return maximumFractionDigits
}
