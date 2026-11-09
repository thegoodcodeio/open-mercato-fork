import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import en from '../../../i18n/en.json'
import pl from '../../../i18n/pl.json'
import { pluralLabel, problemCountLabel } from '../pluralLabel'

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

describe('configurator plural labels', () => {
  const english = translator(en)
  const polish = translator(pl)

  it.each([
    [english, 'en', 1, 'Bill of materials (1 line)', '1 message'],
    [english, 'en', 2, 'Bill of materials (2 lines)', '2 messages'],
    [polish, 'pl', 1, 'Lista materiałów (1 pozycja)', '1 komunikat'],
    [polish, 'pl', 3, 'Lista materiałów (3 pozycje)', '3 komunikaty'],
    [polish, 'pl', 5, 'Lista materiałów (5 pozycji)', '5 komunikatów'],
  ])('reads the BOM title and the live message count in their plural form (%#)', (t, locale, count, bomTitle, messages) => {
    expect(pluralLabel(t, locale, 'product_configurator.configurator.bom.titleCount', 'Bill of materials ({count} lines)', count)).toBe(bomTitle)
    expect(pluralLabel(t, locale, 'product_configurator.configurator.liveMessages', '{count} messages', count)).toBe(messages)
  })
})
