import { describe, it, expect } from 'vitest'
import { managerSiteUrl, mainAppUrl } from '../managerSite'

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
