import * as fs from 'fs'
import * as path from 'path'

// Carried over from the retired `/backend/staff/timesheets` page, whose grid this
// one replaced. The dirty-cell guard is the reason it still exists: the pending-edit
// cue is a warning SURFACE, and a warning surface whose foreground is left unpinned
// is the 1.01:1 dark-mode regression this file was written for.
const GRID_SOURCE = path.resolve(__dirname, '..', 'GridView.tsx')

const STATUS_PALETTES = 'red|orange|amber|yellow|lime|green|emerald|sky|blue|rose'
const VARIANT_PREFIX = '(?:(?:hover|focus|focus-visible|active|disabled|dark|group-hover):)*'
const HARDCODED_STATUS_COLOR = new RegExp(
  `^${VARIANT_PREFIX}(?:text|bg|border)-(?:${STATUS_PALETTES})-\\d{2,3}(?:\\/\\d{1,3})?$`,
)

function readGridSource(): string {
  return fs.readFileSync(GRID_SOURCE, 'utf8')
}

function findHardcodedStatusColors(source: string): string[] {
  return source
    .split(/[\s'"`{}()<>,;=]+/)
    .filter((token) => HARDCODED_STATUS_COLOR.test(token))
}

describe('timesheet grid DS contract', () => {
  it('uses semantic status tokens instead of hardcoded Tailwind palette colors', () => {
    expect(findHardcodedStatusColors(readGridSource())).toEqual([])
  })

  it('marks a dirty cell with warning tokens that carry dedicated dark-mode values', () => {
    const source = readGridSource()

    // Both halves are required. The surface lands on the `<td>`; the legible
    // foreground lands on the `DurationInput` via `inputClassName`. A warning
    // background with `text-muted-foreground` over it is the regression.
    expect(source).toContain("'bg-status-warning-bg'")
    expect(source).toMatch(/isDirty\s*\n?\s*\?\s*'text-status-warning-text'/)
    expect(source).not.toContain('border-amber-400')
  })

  it('never pairs a status token with a dark: override', () => {
    expect(readGridSource()).not.toMatch(/dark:(?:text|bg|border)-status-/)
  })
})
