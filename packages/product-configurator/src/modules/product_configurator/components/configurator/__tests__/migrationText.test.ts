import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { migrationReasonText, oldValueText } from '../session/migrationText'
import type { MigrationItem, SelectionMigration } from '../session/sessionApi'

const t: TranslateFn = (key, fallbackOrParams, params) => {
  const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined
  const values = typeof fallbackOrParams === 'object' ? fallbackOrParams : params
  return (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (values && name in values ? String(values[name]) : token))
}

const length: MigrationItem = { featureKey: 'length', label: 'Length', oldValue: 3, oldDisplay: 3, oldUnit: 'm', reason: 'out_of_range' }

const migration: SelectionMigration = {
  fromVersion: { id: 'version-1', version: 1 },
  toVersion: { id: 'version-2', version: 2 },
  kept: [],
  dropped: [],
  reset: [length],
}

describe('copied value text', () => {
  it('formats a copied number with the unit it had in the old version, also in the reason', () => {
    expect(oldValueText({ ...length, oldValue: 1500, oldDisplay: 1500 }, 'en', t)).toBe('1,500 m')
    expect(migrationReasonText(length, migration, 'en', t)).toBe('3 m is outside the range allowed in v2.')
  })

  it('shows a number without a unit when the old version had none or the migration was stored before units', () => {
    expect(oldValueText({ featureKey: 'length', label: 'Length', oldValue: 3, oldDisplay: 3, reason: 'out_of_range' }, 'en', t)).toBe('3')
  })

  it('shows option labels and yes/no as before', () => {
    expect(oldValueText({ ...length, oldValue: 'green', oldDisplay: 'Racing green', oldUnit: undefined }, 'en', t)).toBe('Racing green')
    expect(oldValueText({ ...length, oldValue: true, oldDisplay: true, oldUnit: undefined }, 'en', t)).toBe('Yes')
  })
})
