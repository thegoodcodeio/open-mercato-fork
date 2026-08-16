import * as fs from 'node:fs'
import * as path from 'node:path'

// Regression for issue #3748: every `staff.timesheets.*` key existed in all four
// locale files, but es.json and de.json carried the English string verbatim as
// the value, so `/backend/staff/timesheets` rendered fully in English for a
// Spanish or German session. `i18n:check-sync` cannot see this — the keys are in
// sync, only the values are untranslated — so this test guards the values.
//
// Keys whose English value is not a word (a number, a sample code) are language
// neutral and stay identical everywhere.
const LANGUAGE_NEUTRAL = new Set([
  'staff.timesheets.my.durationPlaceholder', // "0"
  'staff.timesheets.projects.form.codePlaceholder', // "PROJECT-001"
])

// Real words that are genuinely spelled the same in the target language. Adding
// a key here is a translation decision, not a way to silence the test.
const SAME_IN_LOCALE: Record<string, Set<string>> = {
  pl: new Set([
    'staff.timesheets.my.status', // "Status"
    'staff.timesheets.projects.employees.status',
    'staff.timesheets.projects.form.status',
    'staff.timesheets.projects.table.status',
  ]),
  es: new Set([
    'staff.timesheets.my.total', // "Total"
    'staff.timesheets.widgets.hoursByProject.total',
  ]),
  de: new Set([
    'staff.timesheets.my.status', // "Status"
    'staff.timesheets.projects.employees.status',
    'staff.timesheets.projects.form.status',
    'staff.timesheets.projects.table.status',
    'staff.timesheets.projects.form.code', // "Code"
    'staff.timesheets.projects.form.name', // "Name"
    'staff.timesheets.projects.table.name',
    'staff.timesheets.projects.portfolio.team', // "Team"
  ]),
}

function loadLocale(locale: string): Record<string, string> {
  const file = path.join(__dirname, '..', `${locale}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
}

describe('staff timesheets translations', () => {
  const en = loadLocale('en')
  const timesheetKeys = Object.keys(en).filter((key) => key.startsWith('staff.timesheets.'))

  it('covers the whole timesheets surface', () => {
    expect(timesheetKeys.length).toBeGreaterThan(200)
  })

  it.each(['pl', 'de', 'es'])('%s translates every timesheets key away from English', (locale) => {
    const messages = loadLocale(locale)
    const allowed = SAME_IN_LOCALE[locale]
    const untranslated = timesheetKeys.filter(
      (key) =>
        messages[key] === en[key] && !LANGUAGE_NEUTRAL.has(key) && !allowed.has(key),
    )

    expect(untranslated).toEqual([])
  })

  it.each(['pl', 'de', 'es'])('%s has a non-empty value for every timesheets key', (locale) => {
    const messages = loadLocale(locale)
    for (const key of timesheetKeys) {
      expect(typeof messages[key]).toBe('string')
      expect(messages[key].trim().length).toBeGreaterThan(0)
    }
  })

  it.each(['pl', 'de', 'es'])('%s preserves interpolation placeholders', (locale) => {
    const messages = loadLocale(locale)
    const placeholders = (value: string) => (value.match(/\{\{?[a-zA-Z0-9_]+\}?\}/g) ?? []).sort()
    for (const key of timesheetKeys) {
      expect(placeholders(messages[key])).toEqual(placeholders(en[key]))
    }
  })
})
