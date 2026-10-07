// @vitest-environment node
/**
 * The desktop shell builds two apps (src-tauri/src/flavour.rs): OpenVolley
 * eScoresheet from tauri.conf.json (+ tauri.linux.conf.json), and OpenBeach
 * with tauri.beach.conf.json (+ tauri.beach.linux.conf.json) merged on top,
 * the way `tauri build --config` merges them (JSON merge patch).
 *
 * OpenVolley's identity must never move: its identifier keeps the installed
 * apps' data, its ports are what tablets and the cloud's CORS know, its
 * package / binary / firewall rule are what APT, the updater and the
 * installer act on. OpenBeach must not share any of them.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAURI = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri')
const read = (p) => readFileSync(join(TAURI, p), 'utf8')
const json = (p) => JSON.parse(read(p))

/** RFC 7396, as Tauri merges a platform file and each --config. */
function merge(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = merge(out[k], v)
  }
  return out
}

const base = json('tauri.conf.json')
const ovLinux = merge(base, json('tauri.linux.conf.json'))
const ovWindows = base
const beachWindows = merge(base, json('tauri.beach.conf.json'))
const beachLinux = merge(merge(ovLinux, json('tauri.beach.conf.json')), json('tauri.beach.linux.conf.json'))

/** The fields of `pub const NAME: Flavour = Flavour { ... }` in flavour.rs. */
function rustFlavour(name) {
  const src = read('src/flavour.rs')
  const block = src.match(new RegExp(`pub const ${name}: Flavour = Flavour \\{([\\s\\S]*?)\\n\\};`))
  expect(block, `${name} in flavour.rs`).toBeTruthy()
  const fields = {}
  for (const m of block[1].matchAll(/^\s*(\w+): (?:"([^"]*)"|(\d+)|&\[([^\]]*)\]),/gm)) {
    fields[m[1]] = m[2] ?? (m[3] !== undefined ? Number(m[3]) : [...m[4].matchAll(/"([^"]*)"/g)].map((x) => x[1]))
  }
  return fields
}

/** OV_FW_RULE of one branch of the NSIS hooks' !if on MAINBINARYNAME. */
function nsisRule(beach) {
  const nsh = read('windows/installer-hooks.nsh')
  const m = nsh.match(/!if "\$\{MAINBINARYNAME\}" == "openbeach-escoresheet"([\s\S]*?)!else([\s\S]*?)!endif/)
  expect(m, 'the beach / OpenVolley branch in installer-hooks.nsh').toBeTruthy()
  return (beach ? m[1] : m[2]).match(/!define OV_FW_RULE "([^"]+)"/)[1]
}

const PUBKEY = base.plugins.updater.pubkey

describe('OpenVolley desktop identity (unchanged)', () => {
  it('identifier, names, version, frontend', () => {
    expect(ovWindows.identifier).toBe('com.openvolley.escoresheet')
    expect(ovWindows.productName).toBe('Openvolley eScoresheet')
    expect(ovWindows.mainBinaryName).toBeUndefined()
    expect(ovLinux.productName).toBe('openvolley-escoresheet')
    expect(ovLinux.mainBinaryName).toBe('openvolley-escoresheet')
    expect(base.version).toBe('../package.json')
    expect(base.build).toEqual({
      frontendDist: '../dist',
      beforeBuildCommand: 'npm run build',
      beforeDevCommand: 'npm run dev',
      devUrl: 'http://localhost:5173'
    })
    expect(base.bundle.shortDescription).toBe('Open Source Volleyball eScoresheet')
    expect(base.bundle.windows.nsis).toEqual({ installMode: 'perMachine', installerHooks: 'windows/installer-hooks.nsh' })
    // the Windows exe (and the cargo binary the bundler renames on Linux)
    expect(read('Cargo.toml')).toMatch(/^name = "openvolley-escoresheet"$/m)
  })

  it('updates: get.openvolley.app, then the GitHub "Latest" release', () => {
    expect(base.plugins.updater.endpoints).toEqual([
      'https://get.openvolley.app/desktop/latest.json',
      'https://github.com/Lucanepa/openvolley/releases/latest/download/latest.json'
    ])
  })

  it('deb: package takeover, update helper, desktop entry', () => {
    const deb = ovLinux.bundle.linux.deb
    expect(deb.provides).toEqual(['openvolley-e-scoresheet', 'openvolley'])
    expect(deb.conflicts).toEqual(['openvolley-e-scoresheet', 'openvolley'])
    expect(deb.replaces).toEqual(['openvolley-e-scoresheet', 'openvolley'])
    expect(deb.desktopTemplate).toBe('openvolley-escoresheet.desktop')
    expect(deb.files).toEqual({
      '/usr/libexec/openvolley-escoresheet/apt-upgrade': 'linux/apt-upgrade',
      '/usr/share/polkit-1/actions/com.openvolley.escoresheet.update.policy': 'linux/com.openvolley.escoresheet.update.policy'
    })
    const entry = read('openvolley-escoresheet.desktop')
    expect(entry).toMatch(/^Name=OpenVolley eScoresheet$/m)
    expect(entry).toMatch(/^Categories=Utility;Sports;$/m)
  })

  it('the Rust side: ports, names, firewall rule', () => {
    expect(rustFlavour('OPENVOLLEY')).toEqual({
      key: 'openvolley',
      identifier: 'com.openvolley.escoresheet',
      name: 'OpenVolley',
      window_title: 'OpenVolley eScoresheet',
      http_port: 5173,
      ws_port: 8080,
      package: 'openvolley-escoresheet',
      firewall_rule: 'OpenVolley eScoresheet (tablets on the local network)',
      data_folder: 'OpenVolley',
      ssid_prefix: 'OpenVolley-',
      hotspot_connection_id: 'OpenVolley tablets Wi-Fi',
      bt_connection_id: 'OpenVolley tablets Bluetooth',
      bt_bridge_name: 'pan-openvolley',
      tray_id: 'openvolley',
      staging_endpoint: 'https://get.openvolley.app/desktop/staging.json',
      apt_helper: '/usr/libexec/openvolley-escoresheet/apt-upgrade',
      index_pages: ['index.html']
    })
    expect(nsisRule(false)).toBe('OpenVolley eScoresheet (tablets on the local network)')
    // without OV_FLAVOUR / a beach config, the build is OpenVolley
    expect(read('src/flavour.rs')).toMatch(/#\[cfg\(not\(ov_flavour = "beach"\)\)\]\npub const CURRENT: &Flavour = &OPENVOLLEY;/)
  })
})

describe('OpenBeach desktop flavour', () => {
  const beach = rustFlavour('BEACH')

  it('identifier, names, version and frontend from the openbeach checkout', () => {
    for (const c of [beachWindows, beachLinux]) {
      expect(c.identifier).toBe('com.openvolley.beach')
      expect(c.identifier).toBe(beach.identifier)
      expect(c.mainBinaryName).toBe('openbeach-escoresheet')
      expect(c.version).toBe('../../../openbeach/escoresheet/frontend/package.json')
      expect(c.build.frontendDist).toBe('../../../openbeach/escoresheet/frontend/dist')
      expect(c.build.beforeBuildCommand).toBe('npm --prefix ../../openbeach/escoresheet/frontend run build')
      expect(c.build.devUrl).toBeUndefined()
      expect(c.bundle.shortDescription).toBe('Open Source Beach Volleyball eScoresheet')
      // per machine with the firewall hook, as OpenVolley
      expect(c.bundle.windows.nsis).toEqual(base.bundle.windows.nsis)
      for (const icon of c.bundle.icon) {
        expect(icon.startsWith('icons/beach/'), icon).toBe(true)
        expect(statSync(join(TAURI, icon)).size, icon).toBeGreaterThan(0)
      }
    }
    expect(beachWindows.productName).toBe('OpenBeach')
    expect(beachLinux.productName).toBe('openbeach-escoresheet')
    expect(read('build.rs')).toContain(`const BEACH_IDENTIFIER: &str = "${beach.identifier}";`)
  })

  it('updates: its own manifests, same key, never GitHub\'s "Latest" (OpenVolley\'s fallback)', () => {
    const u = beachLinux.plugins.updater
    expect(u.endpoints).toEqual([
      'https://get.openvolley.app/desktop/beach/latest.json',
      'https://github.com/Lucanepa/openvolley/releases/download/beach-desktop-latest/latest.json'
    ])
    expect(u.endpoints.some((e) => e.includes('/releases/latest/'))).toBe(false)
    expect(u.pubkey).toBe(PUBKEY)
    expect(u.requireSignedVersion).toBe(true)
    expect(beach.staging_endpoint).toBe('https://get.openvolley.app/desktop/beach/staging.json')
  })

  it('deb: none of OpenVolley\'s package relations or files, its own helper and entry', () => {
    const deb = beachLinux.bundle.linux.deb
    expect(deb.provides).toBeUndefined()
    expect(deb.conflicts).toBeUndefined()
    expect(deb.replaces).toBeUndefined()
    expect(deb.depends).toEqual(ovLinux.bundle.linux.deb.depends)
    expect(deb.recommends).toEqual(ovLinux.bundle.linux.deb.recommends)
    expect(deb.files).toEqual({
      '/usr/libexec/openbeach-escoresheet/apt-upgrade': 'linux/beach/apt-upgrade',
      '/usr/share/polkit-1/actions/com.openvolley.beach.update.policy': 'linux/beach/com.openvolley.beach.update.policy'
    })
    expect(Object.keys(deb.files)[0]).toBe(beach.apt_helper)
    expect(statSync(join(TAURI, 'linux/beach/apt-upgrade')).mode & 0o111).toBeTruthy()
    const entry = read(deb.desktopTemplate)
    expect(deb.desktopTemplate).toBe('openbeach-escoresheet.desktop')
    expect(entry).toMatch(/^Name=OpenBeach$/m)
    expect(entry).toMatch(/^Categories=Utility;Sports;$/m)
    // the same template as OpenVolley's but the name
    expect(entry).toBe(read('openvolley-escoresheet.desktop').replace('Name=OpenVolley eScoresheet', 'Name=OpenBeach'))
  })

  it('the update helper and its polkit policy are OpenVolley\'s, for openbeach-escoresheet', () => {
    const asBeach = (s) => s
      .replaceAll('com.openvolley.escoresheet.update', 'com.openvolley.beach.update')
      .replaceAll('openvolley-escoresheet', 'openbeach-escoresheet')
    expect(read('linux/beach/apt-upgrade')).toBe(asBeach(read('linux/apt-upgrade'))
      .replace('# OpenVolley eScoresheet: upgrade', '# OpenBeach (beach volleyball eScoresheet): upgrade'))
    expect(read('linux/beach/com.openvolley.beach.update.policy')).toBe(asBeach(read('linux/com.openvolley.escoresheet.update.policy'))
      .replace('OpenVolley eScoresheet: the app upgrades', 'OpenBeach: the app upgrades')
      .replace('Update OpenVolley eScoresheet', 'Update OpenBeach')
      .replace('to update OpenVolley eScoresheet', 'to update OpenBeach'))
    // both apps come from the one APT repo install.sh adds
    expect(read('linux/beach/apt-upgrade')).toContain('LIST=/etc/apt/sources.list.d/openvolley.list')
  })

  it('shares no port, name, rule or folder with OpenVolley', () => {
    const ov = rustFlavour('OPENVOLLEY')
    expect([beach.http_port, beach.ws_port]).toEqual([5174, 8081])
    expect(beach.window_title).toBe('OpenBeach')
    expect(beach.package).toBe('openbeach-escoresheet')
    for (const k of Object.keys(ov)) {
      if (k === 'index_pages') continue
      expect(beach[k], k).not.toEqual(ov[k])
    }
    expect(nsisRule(true)).toBe(beach.firewall_rule)
    expect(beach.index_pages).toContain('index.html')
  })

  it('the openbeach checkout path is ignored by git', () => {
    const ignore = readFileSync(join(TAURI, '../../../.gitignore'), 'utf8')
    expect(ignore).toMatch(/^\/openbeach$/m)
    expect(existsSync(join(TAURI, 'tauri.beach.linux.conf.json'))).toBe(true)
  })
})
