import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// android-1: the Android app allowed plain http to every host, an
// http://<name>.openvolley.app address included. The venue relays on the hall
// network stay plain http; the cloud is https only.

const frontendDir = resolve(__dirname, '../..')
const xml = readFileSync(resolve(frontendDir, 'android/app/src/main/res/xml/network_security_config.xml'), 'utf8')
const doc = new DOMParser().parseFromString(xml, 'application/xml')

describe('Android network security config', () => {
  it('parses', () => {
    expect(doc.getElementsByTagName('parsererror').length).toBe(0)
    expect(doc.documentElement.tagName).toBe('network-security-config')
  })

  it('keeps plain http for the venue relays on the hall network', () => {
    const base = doc.getElementsByTagName('base-config')[0]
    expect(base.getAttribute('cleartextTrafficPermitted')).toBe('true')
  })

  it('openvolley.app and every subdomain: https only', () => {
    const configs = [...doc.getElementsByTagName('domain-config')]
    const cloud = configs.find(c => [...c.getElementsByTagName('domain')].some(d => d.textContent.trim() === 'openvolley.app'))
    expect(cloud).toBeTruthy()
    expect(cloud.getAttribute('cleartextTrafficPermitted')).toBe('false')
    const domain = [...cloud.getElementsByTagName('domain')].find(d => d.textContent.trim() === 'openvolley.app')
    expect(domain.getAttribute('includeSubdomains')).toBe('true')
  })
})
