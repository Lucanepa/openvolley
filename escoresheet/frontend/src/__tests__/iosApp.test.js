// @vitest-environment node
/**
 * The iOS app (ios/, Capacitor; IOS.md and .github/workflows/ios.yml) is
 * checked here before the macOS runner builds it: its identity is the
 * Android app's, the app's own plugins answer under the names the page asks
 * for, every Swift file is in the Xcode project, and the App Store signing
 * settings agree with ExportOptions.plist.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const IOS = join(FRONTEND, 'ios/App')
const read = (p) => readFileSync(join(IOS, p), 'utf8')
const src = (p) => readFileSync(join(FRONTEND, 'src', p), 'utf8')

const pbxproj = read('App.xcodeproj/project.pbxproj')
const plist = read('App/Info.plist')
const exportOptions = read('ExportOptions.plist')
const capacitor = JSON.parse(readFileSync(join(FRONTEND, 'capacitor.config.json'), 'utf8'))

/** The <string> (or <true/>/<false/>) after <key>name</key> in a plist. */
function plistValue(text, name) {
  const m = text.match(new RegExp(`<key>${name}</key>\\s*(<string>([^<]*)</string>|<(true|false)/>)`))
  if (!m) return undefined
  return m[2] !== undefined ? m[2] : m[3] === 'true'
}

/** The Release build settings of the App target. */
function releaseSettings() {
  const blocks = [...pbxproj.matchAll(/\/\* Release \*\/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{([\s\S]*?)\n\t\t\t\};/g)]
  const app = blocks.map((m) => m[1]).find((b) => b.includes('INFOPLIST_FILE = App/Info.plist'))
  expect(app, 'the App target has a Release configuration').toBeTruthy()
  return app
}

describe('iOS app', () => {
  it('is the Android app: same identifier and name', () => {
    expect(capacitor.appId).toBe('com.openvolley.escoresheet')
    for (const m of pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)) expect(m[1]).toBe(capacitor.appId)
    expect(plistValue(plist, 'CFBundleDisplayName')).toBe('OpenVolley')
  })

  it('Info.plist: camera, local network, Files, no export documents, plain http on the LAN only', () => {
    expect(plistValue(plist, 'NSCameraUsageDescription')).toMatch(/QR/)
    expect(plistValue(plist, 'NSLocalNetworkUsageDescription')).toMatch(/local network/)
    expect(plistValue(plist, 'NSAllowsLocalNetworking')).toBe(true)
    expect(plistValue(plist, 'NSAllowsArbitraryLoadsInWebContent')).toBe(true)
    // never the app-wide exception (App Review asks why)
    expect(plist).not.toMatch(/<key>NSAllowsArbitraryLoads<\/key>/)
    expect(plistValue(plist, 'UIFileSharingEnabled')).toBe(true)
    expect(plistValue(plist, 'LSSupportsOpeningDocumentsInPlace')).toBe(true)
    expect(plistValue(plist, 'ITSAppUsesNonExemptEncryption')).toBe(false)
  })

  it("the app's plugins answer under the names the page registers", () => {
    const plugins = {
      'ScoresheetFilesPlugin.swift': ['OpenVolleyFiles', src('utils/openAppWindow.js'), ['open', 'share']],
    }
    const main = read('App/MainViewController.swift')
    for (const [file, [jsName, page, methods]] of Object.entries(plugins)) {
      const swift = read(`App/${file}`)
      expect(swift).toContain(`public let jsName = "${jsName}"`)
      expect(page).toContain(`'${jsName}'`)
      for (const m of methods) {
        expect(swift).toContain(`CAPPluginMethod(name: "${m}"`)
        expect(swift).toMatch(new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`))
      }
      expect(main).toContain(`registerPluginInstance(${file.replace('.swift', '')}())`)
    }
    expect(read('App/Base.lproj/Main.storyboard')).toContain('customClass="MainViewController" customModule="App"')
    // the bars: Capacitor's own SystemBars on iOS (it owns the home indicator)
    expect(src('utils/nativeSystemBars.js')).toContain("getPlatform?.() === 'ios' ? 'SystemBars' : 'OpenVolleyBars'")
  })

  it('every Swift file of the app is compiled (Sources build phase)', () => {
    for (const f of ['AppDelegate.swift', 'SceneDelegate.swift', 'MainViewController.swift', 'ScoresheetFilesPlugin.swift']) {
      expect(pbxproj, f).toMatch(new RegExp(`/\\* ${f.replace('.', '\\.')} in Sources \\*/,`))
      expect(pbxproj, f).toMatch(new RegExp(`path = ${f.replace('.', '\\.')}; sourceTree`))
    }
  })

  it('Release is signed by hand for the App Store, as ExportOptions.plist exports it', () => {
    const release = releaseSettings()
    expect(release).toContain('CODE_SIGN_STYLE = Manual;')
    expect(release).toContain('DEVELOPMENT_TEAM = T2Q99T2KH5;')
    expect(release).toContain('"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";')
    expect(release).toContain('"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "OpenVolley App Store";')
    expect(plistValue(exportOptions, 'method')).toBe('app-store-connect')
    expect(plistValue(exportOptions, 'teamID')).toBe('T2Q99T2KH5')
    expect(plistValue(exportOptions, 'signingStyle')).toBe('manual')
    expect(exportOptions).toMatch(/<key>com\.openvolley\.escoresheet<\/key>\s*<string>OpenVolley App Store<\/string>/)
  })

  it('a shared App scheme for xcodebuild', () => {
    const scheme = read('App.xcodeproj/xcshareddata/xcschemes/App.xcscheme')
    const target = pbxproj.match(/([0-9A-F]{24}) \/\* App \*\/ = \{\s*isa = PBXNativeTarget;/)[1]
    expect(scheme).toContain(`BlueprintIdentifier = "${target}"`)
  })

  it('the App Store icon: 1024 px, opaque (App Store Connect refuses transparency)', () => {
    const png = readFileSync(join(IOS, 'App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'))
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
    expect(png[25], 'colour type 2: RGB, no alpha').toBe(2)
  })
})
