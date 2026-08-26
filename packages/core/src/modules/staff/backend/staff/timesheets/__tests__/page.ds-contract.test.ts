import * as fs from 'fs'
import * as path from 'path'

const PAGE_SOURCE = path.resolve(__dirname, '..', 'page.tsx')

const STATUS_PALETTES = 'red|orange|amber|yellow|lime|green|emerald|sky|blue|rose'
const VARIANT_PREFIX = '(?:(?:hover|focus|focus-visible|active|disabled|dark|group-hover):)*'
const HARDCODED_STATUS_COLOR = new RegExp(
  `^${VARIANT_PREFIX}(?:text|bg|border)-(?:${STATUS_PALETTES})-\\d{2,3}(?:\\/\\d{1,3})?$`,
)

function readPageSource(): string {
  return fs.readFileSync(PAGE_SOURCE, 'utf8')
}

function findHardcodedStatusColors(source: string): string[] {
  return source
    .split(/[\s'"`{}()<>,;=]+/)
    .filter((token) => HARDCODED_STATUS_COLOR.test(token))
}

describe('My timesheets page DS contract', () => {
  it('uses semantic status tokens instead of hardcoded Tailwind palette colors', () => {
    expect(findHardcodedStatusColors(readPageSource())).toEqual([])
  })

  it('marks a dirty cell with warning tokens that carry dedicated dark-mode values', () => {
    const source = readPageSource()

    // The cell is an InlineInput: the warning surface lands on the wrapper via
    // `className`, the legible foreground on the field itself via `inputClassName`.
    // Both halves are required — the warning background with an unpinned text
    // colour is exactly the 1.01:1 dark-mode regression this guard exists for.
    expect(source).toContain('border-status-warning-border bg-status-warning-bg')
    expect(source).toMatch(/isDirty\s*\n?\s*\?\s*'text-status-warning-text'/)
    expect(source).not.toContain('border-amber-400')
  })

  it('never pairs a status token with a dark: override', () => {
    expect(readPageSource()).not.toMatch(/dark:(?:text|bg|border)-status-/)
  })
})
