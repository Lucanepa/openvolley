// @vitest-environment node
// SEC-53: on Linux the tablets' network fell back to firewalld zone
// "trusted" (every port of the laptop open to the hotspot) for every package
// but the .deb, which alone shipped the app's zone. The zone choice is
// nm_settings.rs (the_tablets_get_the_own_zone_never_trusted: never
// "trusted", a refusal with the root command instead); these check that every
// Linux package carries the zone.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const frontendDir = resolve(__dirname, '../..')
const packagingDir = resolve(frontendDir, '../packaging')
const json = (p) => JSON.parse(readFileSync(resolve(frontendDir, p), 'utf8'))

describe('every Linux package carries the tablets\' firewalld zone (SEC-53)', () => {
  const zones = { openvolley: 'openvolley-tablets', beach: 'openbeach-tablets' }

  it('the AppImage (as the .deb)', () => {
    const linux = json('src-tauri/tauri.linux.conf.json').bundle.linux
    expect(linux.appimage.files).toEqual({ '/usr/lib/firewalld/zones/openvolley-tablets.xml': 'linux/openvolley-tablets.xml' })
    expect(linux.deb.files['/usr/lib/firewalld/zones/openvolley-tablets.xml']).toBe('linux/openvolley-tablets.xml')
    const beach = json('src-tauri/tauri.beach.linux.conf.json').bundle.linux
    expect(beach.appimage.files).toEqual({ '/usr/lib/firewalld/zones/openvolley-tablets.xml': null, '/usr/lib/firewalld/zones/openbeach-tablets.xml': 'linux/beach/openbeach-tablets.xml' })
  })

  it('the AUR packages install it from the .deb', () => {
    for (const [pkg, zone] of [['openvolley-escoresheet-bin', zones.openvolley], ['openbeach-escoresheet-bin', zones.beach]]) {
      const build = readFileSync(resolve(packagingDir, 'aur', pkg, 'PKGBUILD'), 'utf8')
      expect(build, pkg).toContain(`install -Dm644 deb/usr/lib/firewalld/zones/${zone}.xml`)
      expect(build, pkg).toContain(`"$pkgdir/usr/lib/firewalld/zones/${zone}.xml"`)
    }
  })

  it('the Flatpaks carry it and may ask firewalld (read only) whether it is there', () => {
    for (const [app, zone] of [['com.openvolley.escoresheet', zones.openvolley], ['com.openvolley.beach', zones.beach]]) {
      const manifest = JSON.parse(readFileSync(resolve(packagingDir, 'flatpak', `${app}.json`), 'utf8'))
      expect(manifest['finish-args'], app).toContain('--system-talk-name=org.fedoraproject.FirewallD1')
      const cmds = manifest.modules.find((m) => typeof m === 'object')['build-commands']
      expect(cmds.join('\n'), app).toContain(`install -Dm644 usr/lib/firewalld/zones/${zone}.xml \${FLATPAK_DEST}/lib/firewalld/zones/${zone}.xml`)
    }
  })

  it('the snaps keep the .deb\'s zone file (only the APT helper and its polkit action are left out)', () => {
    for (const snap of ['openvolley-escoresheet', 'openbeach-escoresheet']) {
      const yaml = readFileSync(resolve(packagingDir, 'snap', snap, 'snap', 'snapcraft.yaml'), 'utf8')
      const prime = yaml.match(/prime:\n((?:\s+- .*\n)+)/)?.[1] || ''
      expect(prime, snap).not.toMatch(/usr\/lib/)
    }
  })
})
