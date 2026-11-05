export const PRICE_SCALE = 4
export const QUANTITY_SCALE = 6

type ParsedDecimal = { coefficient: bigint; scale: number }

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

export function parseDecimal(input: string | number): ParsedDecimal {
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new Error(`[internal] product_configurator: non-finite decimal ${input}`)
  }
  const match = DECIMAL_PATTERN.exec(String(input).trim())
  if (!match) throw new Error(`[internal] product_configurator: invalid decimal ${String(input)}`)
  const [, sign, whole, fraction = '', exponent = '0'] = match
  const digits = BigInt(`${whole}${fraction}`)
  const scale = fraction.length - Number(exponent)
  const signed = sign === '-' ? -digits : digits
  if (scale >= 0) return { coefficient: signed, scale }
  return { coefficient: signed * 10n ** BigInt(-scale), scale: 0 }
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
