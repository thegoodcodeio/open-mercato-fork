import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'

/** Reads `<base>.one|few|many|other` by the locale's plural rules; a locale without that form falls back to `<base>.other`. */
export function pluralLabel(t: TranslateFn, locale: string, base: string, fallback: string, count: number): string {
  const key = `${base}.${new Intl.PluralRules(locale).select(count)}`
  const resolved = t(key, { count })
  return resolved === key ? t(`${base}.other`, fallback, { count }) : resolved
}

export function problemCountLabel(t: TranslateFn, locale: string, count: number): string {
  return pluralLabel(t, locale, 'product_configurator.studio.problemsCount', '{count} problems', count)
}
