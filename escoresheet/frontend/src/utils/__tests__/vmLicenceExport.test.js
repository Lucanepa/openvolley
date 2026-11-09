// The club administration export of VolleyManager, read in the browser
// (db/024, docs/club-licences-spec.md): small made-up workbooks written with
// jszip here, in the layout of a real export (title row, blank row, header
// row 3, then one row per person, many columns that must be ignored).
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readLicenceExport, licencePeopleFromRows, excelSerialToIso, cellToIsoDate, normalizeHeader, LicenceExportError } from '../vmLicenceExport'

const serialOf = (iso) => (Date.UTC(...iso.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) - Date.UTC(1899, 11, 30)) / 86400000
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const col = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }

/**
 * A minimal .xlsx: `rows` of cells; a cell is a string (a shared string, or
 * inline with { inline: true }), a number, { date: serial } (a number with a
 * date style), { d: 'ISO' } (t="d"), { str: '...' } (t="str"), or null.
 */
async function xlsx(rows, { inline = false, date1904 = false, sheetName = 'Sheet1', sheetFile = 'sheet1.xml' } = {}) {
  const shared = []
  const sharedIndex = new Map()
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v == null) return ''
      const ref = `${col(c)}${r + 1}`
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
      if (v.date !== undefined) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`
      if (v.d !== undefined) return `<c r="${ref}" t="d"><v>${esc(v.d)}</v></c>`
      if (v.str !== undefined) return `<c r="${ref}" t="str"><f>A1</f><v>${esc(v.str)}</v></c>`
      if (inline) return `<c r="${ref}" t="inlineStr"><is><r><t>${esc(v)}</t></r></is></c>`
      if (!sharedIndex.has(v)) { sharedIndex.set(v, shared.length); shared.push(v) }
      return `<c r="${ref}" t="s"><v>${sharedIndex.get(v)}</v></c>`
    }).join('')
    return `<row r="${r + 1}">${cells}</row>`
  }).join('')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId7"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${sheetFile}"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>')
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`)
  zip.file(`xl/worksheets/${sheetFile}`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'uint8array' })
}

// Made-up people of VBC Musterdorf (no real person), with what an export
// also carries and must never leave the reader
const ITALIAN = [
  ['Lista dei giocatori · VBC Musterdorf'],
  [],
  ['N. SV', 'Cognome', 'Nome', 'Data di nascita', 'Sesso', 'Nazionalità', 'FdO', 'Categoria', 'Indirizzo E-mail', 'N. telefono', 'Indirizzo'],
  [100001, 'Beispiel', 'Anna', { date: serialOf('2004-05-06') }, 'D', 'Svizzera', 'FdO', 'U23', 'anna@example.ch', '+41 00 000 00 01', 'Musterweg 1'],
  [100002, 'Muster', 'Lea Sofia', { date: serialOf('2006-01-31') }, 'D', 'Svizzera', '', 'U20', 'lea@example.ch', '+41 00 000 00 02', 'Musterweg 2'],
  [100003, 'Probe', 'Marco', { date: serialOf('2001-11-02') + 0.5 }, 'U', 'Italia', '', 'Senior', 'marco@example.ch', '+41 00 000 00 03', 'Musterweg 3']
]

describe('excel dates', () => {
  it('1900 system with its leap-year bug', () => {
    expect(excelSerialToIso(1)).toBe('1900-01-01')
    expect(excelSerialToIso(59)).toBe('1900-02-28')
    expect(excelSerialToIso(60)).toBeNull() // the 29 February 1900 Excel counts
    expect(excelSerialToIso(61)).toBe('1900-03-01')
    expect(excelSerialToIso(45000)).toBe('2023-03-15')
    expect(excelSerialToIso(serialOf('2004-05-06') + 0.75)).toBe('2004-05-06')
    expect(excelSerialToIso(0)).toBeNull()
    expect(excelSerialToIso(-3)).toBeNull()
  })

  it('1904 system', () => {
    expect(excelSerialToIso(0, { date1904: true })).toBe('1904-01-01')
    expect(excelSerialToIso(43538, { date1904: true })).toBe('2023-03-15')
  })

  it('a date of birth cell: serial, ISO, DD.MM.YYYY, anything else none', () => {
    expect(cellToIsoDate(serialOf('2006-01-31'))).toBe('2006-01-31')
    expect(cellToIsoDate('2006-01-31T00:00:00')).toBe('2006-01-31')
    expect(cellToIsoDate('2006-01-31')).toBe('2006-01-31')
    expect(cellToIsoDate('31.01.2006')).toBe('2006-01-31')
    expect(cellToIsoDate('1.2.2006')).toBe('2006-02-01')
    expect(cellToIsoDate('31.02.2006')).toBeNull()
    expect(cellToIsoDate('soon')).toBeNull()
    expect(cellToIsoDate('')).toBeNull()
  })

  it('headers: lowercase, trimmed, spaces collapsed, no dots or colons', () => {
    expect(normalizeHeader(' N. SV ')).toBe('n sv')
    expect(normalizeHeader('SV-Nr.')).toBe('sv-nr')
    expect(normalizeHeader('Date  of birth:')).toBe('date of birth')
    expect(normalizeHeader('N° SV')).toBe('n° sv')
  })
})

describe('readLicenceExport', () => {
  it('Italian: the five fields only, nothing else of the row', async () => {
    const r = await readLicenceExport(await xlsx(ITALIAN))
    expect(r.language).toBe('it')
    expect(r.rows).toBe(3)
    expect(r.skipped).toBe(0)
    expect(r.people).toEqual([
      { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' },
      { sv_number: '100002', last_name: 'Muster', first_name: 'Lea Sofia', dob: '2006-01-31', gender: 'f' },
      { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
    ])
    expect(Object.keys(r).sort()).toEqual(['language', 'people', 'rows', 'skipped'])
    const text = JSON.stringify(r)
    for (const leak of ['example.ch', '+41', 'Musterweg', 'Svizzera', 'Italia', 'U23', 'FdO']) expect(text).not.toContain(leak)
  })

  it('German: SV-Nr., Name = last name, Vorname, DD.MM.YYYY and ISO dates, inline strings', async () => {
    const r = await readLicenceExport(await xlsx([
      ['Spielerliste'],
      [],
      ['SV-Nr.', 'Name', 'Vorname', 'Geburtsdatum', 'Geschlecht', 'Nationalität', 'E-Mail-Adresse', 'Telefonnummer'],
      ['200001', 'Testmann', 'Noah', '03.04.2007', 'M', 'Schweiz', 'noah@example.ch', '000'],
      [200002, 'Muster-Probe', 'Mia', { d: '2005-12-24T00:00:00' }, 'W', 'Schweiz', 'mia@example.ch', '000'],
      [200003, '  Beispiel  ', '  ', null, 'F', null, null, null]
    ], { inline: true }))
    expect(r.language).toBe('de')
    expect(r.people).toEqual([
      { sv_number: '200001', last_name: 'Testmann', first_name: 'Noah', dob: '2007-04-03', gender: 'm' },
      { sv_number: '200002', last_name: 'Muster-Probe', first_name: 'Mia', dob: '2005-12-24', gender: 'f' },
      { sv_number: '200003', last_name: 'Beispiel', first_name: null, dob: null, gender: 'f' }
    ])
  })

  it('French: Nom is the last name and Prénom the first name (not the Italian Nome)', async () => {
    const r = await readLicenceExport(await xlsx([
      ['Liste des joueurs'],
      [],
      ['N° SV', 'Nom', 'Prénom', 'Date de naissance', 'Sexe', 'Adresse e-mail'],
      [300001, 'Exemple', 'Chloé', { date: serialOf('2003-07-14') }, 'F', 'chloe@example.ch'],
      [300002, 'Modèle', 'Hugo', { str: '2002-02-02' }, 'H', 'hugo@example.ch']
    ]))
    expect(r.language).toBe('fr')
    expect(r.people).toEqual([
      { sv_number: '300001', last_name: 'Exemple', first_name: 'Chloé', dob: '2003-07-14', gender: 'f' },
      { sv_number: '300002', last_name: 'Modèle', first_name: 'Hugo', dob: '2002-02-02', gender: 'm' }
    ])
    // a French export with the Italian licence header keeps the French columns
    const mixed = await readLicenceExport(await xlsx([['N. SV', 'Nom', 'Prénom'], [300003, 'Essai', 'Léa']]))
    expect(mixed.language).toBe('fr')
    expect(mixed.people[0]).toMatchObject({ last_name: 'Essai', first_name: 'Léa' })
  })

  it('English, the 1904 date system, another sheet file name', async () => {
    const r = await readLicenceExport(await xlsx([
      ['SV no.', 'Last name', 'First name', 'Date of birth', 'Gender'],
      [400001, 'Sample', 'Sam', { date: 36000 }, 'M']
    ], { date1904: true, sheetFile: 'data.xml' }))
    expect(r.language).toBe('en')
    expect(r.people).toEqual([{ sv_number: '400001', last_name: 'Sample', first_name: 'Sam', dob: excelSerialToIso(36000, { date1904: true }), gender: 'm' }])
  })

  it('rows without a usable licence number or last name are skipped and counted; a licence twice is one person', async () => {
    const r = await readLicenceExport(await xlsx([
      ['N. SV', 'Cognome', 'Nome', 'Data di nascita', 'Sesso'],
      [100001, 'Beispiel', 'Anna', null, 'D'],
      [12, 'Corto', 'Numero', null, 'D'],
      ['abc123', 'Lettere', 'Numero', null, 'U'],
      [100005, null, 'Senza', null, 'U'],
      [],
      [100001, 'Beispiel', 'Anna', { date: serialOf('2004-05-06') }, 'D']
    ]))
    expect(r.rows).toBe(5)
    expect(r.skipped).toBe(3)
    expect(r.people).toEqual([{ sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }])
  })

  it('a licence column with another header: the column whose values are all licence numbers', async () => {
    const r = await readLicenceExport(await xlsx([
      ['Lizenz', 'Name', 'Vorname', 'Verein'],
      [500001, 'Muster', 'Max', 'VBC Musterdorf'],
      ['500002', 'Probe', 'Pia', 'VBC Musterdorf']
    ]))
    expect(r.people.map((p) => p.sv_number)).toEqual(['500001', '500002'])
  })

  it('refuses a file without a licence column, or without names, with what is missing', async () => {
    const noLicence = await xlsx([
      ['Lista'],
      [],
      ['Cognome', 'Nome', 'Data di nascita', 'Indirizzo E-mail'],
      ['Beispiel', 'Anna', { date: serialOf('2004-05-06') }, 'anna@example.ch']
    ])
    await expect(readLicenceExport(noLicence)).rejects.toMatchObject({ code: 'OV_LICENCE_NO_HEADER', missing: ['sv_number'] })
    await expect(readLicenceExport(await xlsx([['Foo', 'Bar'], [1, 2]]))).rejects.toBeInstanceOf(LicenceExportError)
    expect(() => licencePeopleFromRows([['SV-Nr.', 'Name'], [100001, 'Muster']])).toThrow(/first_name/)
  })

  it('refuses a file that is not an .xlsx', async () => {
    await expect(readLicenceExport(new TextEncoder().encode('N. SV;Cognome;Nome\n100001;Beispiel;Anna'))).rejects.toMatchObject({ code: 'OV_LICENCE_NOT_XLSX' })
    await expect(readLicenceExport(new Uint8Array())).rejects.toMatchObject({ code: 'OV_LICENCE_NOT_XLSX' })
  })

  it('reads a Blob (a picked file)', async () => {
    const bytes = await xlsx(ITALIAN)
    const r = await readLicenceExport(new Blob([bytes]))
    expect(r.people).toHaveLength(3)
  })
})
