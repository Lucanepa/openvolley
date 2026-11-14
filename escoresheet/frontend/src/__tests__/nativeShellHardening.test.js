// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { subdomains, extraFilesFor, headersFor } from '../../scripts/build-subdomains.js'
import { contentSecurityPolicy, cspMeta, securityHeaderLines, THEME_BOOT_HASH } from '../../csp.js'
import { THEME_BOOT_SCRIPT } from '../../theme-boot.js'

const frontendDir = resolve(__dirname, '../..')
const read = (p) => readFileSync(resolve(frontendDir, p), 'utf8')

describe('Android app data stays out of Google backup and device transfer (android-3)', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')

  it('allowBackup is off and the extraction rules are set', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/)
    expect(manifest).not.toMatch(/android:allowBackup="true"/)
    expect(manifest).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/)
  })

  it('the rules exclude every domain from the cloud backup and the transfer', () => {
    const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml')
    const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref']
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = rules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1]
      expect(body, section).toBeTruthy()
      expect(body).not.toMatch(/<include/)
      for (const d of domains) expect(body, `${section} ${d}`).toContain(`<exclude domain="${d}" path="." />`)
    }
  })
})

describe('FileProvider shares the app folders only (android-6)', () => {
  const paths = read('android/app/src/main/res/xml/file_paths.xml')

  it('no whole shared storage, no cache', () => {
    expect(paths).not.toMatch(/path="\."/)
    expect(paths).not.toMatch(/<cache-path/)
    expect(paths).not.toMatch(/<external-cache-path/)
    expect(paths).not.toMatch(/<root-path/)
  })

  it('the scoresheet folders ScoresheetFilesPlugin hands out, and the file field camera folder', () => {
    expect(paths).toContain('<files-path name="scoresheets" path="OpenVolley/scoresheets/" />')
    expect(paths).toContain('<external-files-path name="scoresheets_external" path="OpenVolley/scoresheets/" />')
    expect(paths).toContain('<external-path name="scoresheets_documents" path="Documents/OpenVolley/scoresheets/" />')
    expect(paths).toContain('<external-files-path name="captures" path="Pictures/" />')
    const plugin = read('android/app/src/main/java/com/openvolley/escoresheet/ScoresheetFilesPlugin.java')
    expect(plugin).toContain('static final String SUBDIR = "OpenVolley/scoresheets"')
  })
})

describe('Content-Security-Policy (fe-shell-pwa-6, android-7)', () => {
  it('the theme boot script is allowed by its hash, no other inline script, no eval', () => {
    const hash = `'sha256-${createHash('sha256').update(THEME_BOOT_SCRIPT).digest('base64')}'`
    expect(THEME_BOOT_HASH).toBe(hash)
    const policy = contentSecurityPolicy()
    const script = policy.match(/script-src ([^;]+)/)[1]
    expect(script).toBe(`'self' 'wasm-unsafe-eval' ${hash}`)
    expect(policy).not.toMatch(/'unsafe-eval'/)
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'self'")
    expect(policy).toContain("img-src 'self' data: blob:;")
    expect(policy).toContain("frame-ancestors 'self'")
    expect(contentSecurityPolicy({ frameAncestors: null })).not.toContain('frame-ancestors')
  })

  it('every web build sends it with frame protection; a dev build as Report-Only', () => {
    for (const name of Object.keys(subdomains)) {
      const prod = extraFilesFor(subdomains[name], 'production')._headers
      expect(prod, name).toMatch(/^\/\*\n/)
      expect(prod, name).toMatch(/\n {2}Content-Security-Policy: default-src 'self'; /)
      expect(prod, name).toContain('X-Content-Type-Options: nosniff')
      const dev = headersFor(subdomains[name], 'dev')
      expect(dev, name).toContain('Content-Security-Policy-Report-Only: ')
      expect(dev, name).not.toMatch(/\n {2}Content-Security-Policy: /)
    }
    // the scorer, referee and bench pages: only the app's own pages may frame them
    for (const name of ['app', 'referee', 'bench', 'roster', 'scoresheet']) {
      const h = headersFor(subdomains[name], 'production')
      expect(h, name).toContain("frame-ancestors 'self'")
      expect(h, name).toContain('X-Frame-Options: SAMEORIGIN')
    }
    // the manager consoles: no frames at all, and noindex
    for (const name of ['manager', 'manager-beach']) {
      const h = headersFor(subdomains[name], 'production')
      expect(h, name).toContain("frame-ancestors 'none'")
      expect(h, name).toContain('X-Frame-Options: DENY')
      expect(h, name).toContain('X-Robots-Tag: noindex, nofollow')
      expect(h.match(/X-Frame-Options/g)).toHaveLength(1)
    }
    // the livescore display may be shown in a club's page
    expect(securityHeaderLines('livescore').join('\n')).not.toMatch(/frame-ancestors|X-Frame-Options/)
  })

  it('the Android build carries it as a <meta> above every script (vite.config.js)', () => {
    const tags = cspMeta({ enabled: true }).transformIndexHtml('<html></html>')
    expect(tags).toEqual([{
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy({ frameAncestors: null }) },
      injectTo: 'head-prepend'
    }])
    expect(cspMeta({ enabled: false }).transformIndexHtml('<html></html>')).toBe('<html></html>')
    const config = read('vite.config.js')
    expect(config).toMatch(/cspMeta\(\{ enabled: isCapacitor \}\)/)
    // after themeBoot in the plugin list: Vite prepends later plugins' tags first
    expect(config.indexOf('cspMeta({')).toBeGreaterThan(config.indexOf('themeBoot()'))
  })
})
