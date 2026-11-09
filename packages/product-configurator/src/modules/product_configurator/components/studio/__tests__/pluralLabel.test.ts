import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { problemCountLabel } from '../pluralLabel'

function translator(dict: Record<string, string>): TranslateFn {
  return (key, fallbackOrParams, maybeParams) => {
    const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : maybeParams
    const template = dict[key] ?? (typeof fallbackOrParams === 'string' ? fallbackOrParams : key)
    return template.replace('{count}', String(params?.count ?? ''))
  }
}

describe('problemCountLabel', () => {
  const polish = translator({
    'product_configurator.studio.problemsCount.one': '{count} problem',
    'product_configurator.studio.problemsCount.few': '{count} problemy',
    'product_configurator.studio.problemsCount.many': '{count} problemów',
    'product_configurator.studio.problemsCount.other': '{count} problemu',
  })

  it.each([
    [1, '1 problem'],
    [3, '3 problemy'],
    [5, '5 problemów'],
  ])('picks the Polish plural form for %i', (count, expected) => {
    expect(problemCountLabel(polish, 'pl', count)).toBe(expected)
  })

  it('falls back to the other form, then to the English text, when a form is missing', () => {
    expect(problemCountLabel(translator({ 'product_configurator.studio.problemsCount.other': '{count} issues' }), 'en', 1)).toBe('1 issues')
    expect(problemCountLabel(translator({}), 'en', 2)).toBe('2 problems')
  })
})
