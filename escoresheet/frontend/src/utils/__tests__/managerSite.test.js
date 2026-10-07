import { describe, it, expect } from 'vitest'
import { managerSiteUrl, mainAppUrl, managerSignUpUrl, signUpNeedsInternetNote } from '../managerSite'

const web = {}

describe('managerSiteUrl (the main app console links the manager site)', () => {
  it('links production from *.openvolley.app', () => {
    expect(managerSiteUrl('app.openvolley.app', web)).toBe('https://manager.openvolley.app')
    expect(managerSiteUrl('dev-app.openvolley.app', web)).toBe('https://manager.openvolley.app')
  })

  it('links the matching Pages preview, production for a deployment hash', () => {
    expect(managerSiteUrl('dev.openvolley-app.pages.dev', web)).toBe('https://dev.openvolley-manager.pages.dev')
    expect(managerSiteUrl('openvolley-app.pages.dev', web)).toBe('https://openvolley-manager.pages.dev')
    expect(managerSiteUrl('1a2b3c4d.openvolley-app.pages.dev', web)).toBe('https://openvolley-manager.pages.dev')
  })

  it('no link in the desktop and Android apps, on the LAN server or in development', () => {
    expect(managerSiteUrl('app.openvolley.app', { __TAURI_INTERNALS__: {} })).toBeNull()
    expect(managerSiteUrl('localhost', { Capacitor: { isNativePlatform: () => true } })).toBeNull()
    expect(managerSiteUrl('app.openvolley.app', { electronAPI: {} })).toBeNull()
    expect(managerSiteUrl('192.168.1.20', web)).toBeNull()
    expect(managerSiteUrl('localhost', web)).toBeNull()
  })
})

describe('mainAppUrl (the manager links back to the scorer app)', () => {
  it('production, the matching preview, or this origin in development', () => {
    expect(mainAppUrl('manager.openvolley.app')).toBe('https://app.openvolley.app/')
    expect(mainAppUrl('dev.openvolley-manager.pages.dev')).toBe('https://dev.openvolley-app.pages.dev/')
    expect(mainAppUrl('9f8e7d6c.openvolley-manager.pages.dev')).toBe('https://openvolley-app.pages.dev/')
    expect(mainAppUrl('localhost', 'http://localhost:5173')).toBe('http://localhost:5173/')
    expect(mainAppUrl('example.org')).toBe('https://app.openvolley.app/')
  })
})

describe('managerSignUpUrl (the scorer apps link the manager sign-up page)', () => {
  it('the public manager site everywhere: web, desktop, Android, the LAN server, development', () => {
    const url = 'https://manager.openvolley.app/#signup'
    expect(managerSignUpUrl('app.openvolley.app', web)).toBe(url)
    expect(managerSignUpUrl('app.openvolley.app', { __TAURI_INTERNALS__: {} })).toBe(url)
    expect(managerSignUpUrl('localhost', { Capacitor: { isNativePlatform: () => true } })).toBe(url)
    expect(managerSignUpUrl('192.168.1.20', web)).toBe(url)
    expect(managerSignUpUrl('localhost', web)).toBe(url)
  })

  it('a Pages preview of the app links the matching manager preview', () => {
    expect(managerSignUpUrl('dev.openvolley-app.pages.dev', web)).toBe('https://dev.openvolley-manager.pages.dev/#signup')
    expect(managerSignUpUrl('1a2b3c4d.openvolley-app.pages.dev', web)).toBe('https://openvolley-manager.pages.dev/#signup')
  })
})

describe('signUpNeedsInternetNote', () => {
  it('not on the public website while online', () => {
    expect(signUpNeedsInternetNote('app.openvolley.app', { navigator: { onLine: true } })).toBe(false)
    expect(signUpNeedsInternetNote('dev.openvolley-app.pages.dev', web)).toBe(false)
  })

  it('in the apps, on the LAN server, in development and whenever offline', () => {
    expect(signUpNeedsInternetNote('app.openvolley.app', { __TAURI_INTERNALS__: {} })).toBe(true)
    expect(signUpNeedsInternetNote('localhost', { Capacitor: { isNativePlatform: () => true } })).toBe(true)
    expect(signUpNeedsInternetNote('192.168.1.20', web)).toBe(true)
    expect(signUpNeedsInternetNote('localhost', web)).toBe(true)
    expect(signUpNeedsInternetNote('app.openvolley.app', { navigator: { onLine: false } })).toBe(true)
  })
})
