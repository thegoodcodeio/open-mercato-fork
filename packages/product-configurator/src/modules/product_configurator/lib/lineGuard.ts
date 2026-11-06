import { sameDecimal } from './money'
import { hasConfigurationMarker, readConfigurationMarker, type StoredLine } from './quoteAccess'

const TRUSTED_REQUESTS_KEY = '__openMercatoProductConfiguratorTrustedRequests__'

/**
 * Requests finalise creates for its own `sales.quotes.lines.upsert`. Commands run in-process on the
 * command bus, so no public route can present one. Kept on `globalThis` so duplicated module
 * instances in one process (dev HMR, server chunks) share the set.
 */
function trustedRequests(): WeakSet<Request> {
  const holder = globalThis as Record<string, unknown>
  const existing = holder[TRUSTED_REQUESTS_KEY]
  if (existing instanceof WeakSet) return existing as WeakSet<Request>
  const created = new WeakSet<Request>()
  holder[TRUSTED_REQUESTS_KEY] = created
  return created
}

export function markTrustedFinaliseRequest(request: Request): Request {
  trustedRequests().add(request)
  return request
}

export function isTrustedFinaliseRequest(request: Request | null | undefined): boolean {
  return request instanceof Request && trustedRequests().has(request)
}

export const PROTECTED_REFERENCE_FIELDS = ['productId', 'productVariantId', 'currencyCode', 'quantityUnit'] as const
export const PROTECTED_AMOUNT_FIELDS = ['quantity', 'unitPriceNet', 'taxAmount', 'totalNetAmount', 'totalGrossAmount'] as const

type ProtectedField = (typeof PROTECTED_REFERENCE_FIELDS)[number] | (typeof PROTECTED_AMOUNT_FIELDS)[number] | 'configuration'

/**
 * Sales calculates totals with the submitted value and stores it as `numeric(18,4)`, so an amount is
 * unchanged only when it is the same decimal exactly: `1` equals `1.0000`, `1.00004` does not.
 */
function sameAmount(input: unknown, stored: string | null): boolean {
  if (typeof input !== 'string' && typeof input !== 'number') return false
  return sameDecimal(input, stored ?? 0)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function storedReference(line: StoredLine, field: (typeof PROTECTED_REFERENCE_FIELDS)[number]): string | null {
  return line[field]
}

/**
 * The protected fields a body changes on a configured line: the marker (also `{}` or `null`), product,
 * variant, currency, unit, quantity, net unit price and the explicit amounts sales would take as given.
 */
export function changedProtectedFields(body: Record<string, unknown>, stored: StoredLine): ProtectedField[] {
  const changed: ProtectedField[] = []
  if (body.configuration !== undefined && canonicalJson(body.configuration) !== canonicalJson(stored.configuration)) {
    changed.push('configuration')
  }
  for (const field of PROTECTED_REFERENCE_FIELDS) {
    if (body[field] === undefined) continue
    if ((body[field] ?? null) !== storedReference(stored, field)) changed.push(field)
  }
  for (const field of PROTECTED_AMOUNT_FIELDS) {
    if (body[field] === undefined) continue
    if (!sameAmount(body[field], stored[field])) changed.push(field)
  }
  return changed
}

export function bodyCarriesMarker(body: Record<string, unknown>): boolean {
  return hasConfigurationMarker(body.configuration)
}

export type LineGuardVerdict =
  | { kind: 'allow' }
  | { kind: 'locked'; fields: ProtectedField[] }
  | { kind: 'forged' }
  | { kind: 'verify_insert'; snapshotId: string | null; hash: string | null }

/**
 * The guard decision for one line write that does not need another read. `stored` is the line read
 * fresh by `body.id` (null for an insert or an id that does not exist yet). Inserts with the marker
 * need the snapshot check (`verify_insert`) and are allowed only for quote lines on a trusted request.
 */
export function judgeLineWrite(input: {
  body: Record<string, unknown>
  stored: StoredLine | null
  allowTrustedInsert: boolean
  trusted: boolean
}): LineGuardVerdict {
  const { body, stored } = input
  if (stored && readConfigurationMarker(stored.configuration)) {
    const fields = changedProtectedFields(body, stored)
    return fields.length ? { kind: 'locked', fields } : { kind: 'allow' }
  }
  if (!bodyCarriesMarker(body)) return { kind: 'allow' }
  if (stored || typeof body.id === 'string' || !input.allowTrustedInsert || !input.trusted) return { kind: 'forged' }
  const marker = readConfigurationMarker(body.configuration)
  return { kind: 'verify_insert', snapshotId: marker?.snapshotId ?? null, hash: marker?.hash ?? null }
}

export type PendingSnapshotFacts = {
  quoteId: string
  quoteLineId: string | null
  sessionStatus: string | null
  hash: string
  netPrice: string
  currencyCode: string
  productId: string | null
}

/** A trusted configured insert must match the pending snapshot it references exactly. */
export function insertMatchesSnapshot(body: Record<string, unknown>, hash: string | null, snapshot: PendingSnapshotFacts | null): boolean {
  if (!snapshot || snapshot.quoteLineId || snapshot.sessionStatus !== 'finalising') return false
  return (
    body.quoteId === snapshot.quoteId &&
    hash === snapshot.hash &&
    snapshot.productId !== null &&
    body.productId === snapshot.productId &&
    body.currencyCode === snapshot.currencyCode &&
    sameAmount(body.quantity, '1') &&
    sameAmount(body.unitPriceNet, snapshot.netPrice)
  )
}
