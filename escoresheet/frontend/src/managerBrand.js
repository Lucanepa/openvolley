/**
 * The manager console is one code base built twice (plan 1.6,
 * ~/ov-ops/openbeach-separation-tournaments-PLAN.md):
 *
 *   manager.openvolley.app        OpenVolley (indoor)  manager.html       -> src/manager-main.jsx
 *   manager-beach.openvolley.app  OpenBeach (beach)    manager-beach.html -> src/manager-beach-main.jsx
 *
 * The entry chooses the brand (ManagerBrandProvider); everything else reads
 * it with useManagerBrand(). A brand sets the name, the logo, the scorer app
 * it links to, the tabs of the console, the `app` the account lists, invites
 * and audit are scoped to, and the `app` the auth calls send (which only
 * chooses the mail's brand and link host: the server never authorises by it).
 *
 * Without a provider the brand is OpenVolley's: every screen outside the
 * OpenBeach manager (the main app's manage console included) is OpenVolley's
 * console, whose lists are scoped to ?app=indoor.
 */
import { createContext, createElement, useContext } from 'react'
import { BRAND } from './brand'
import beachMark from '../brand/beach/mark.svg'
import beachLockup from '../brand/beach/lockup.svg'

export const MANAGER_BRANDS = Object.freeze({
  indoor: Object.freeze({
    app: 'indoor',
    name: 'OpenVolley',
    lockup: BRAND.lockup,
    mark: BRAND.mark,
    siteUrl: 'https://manager.openvolley.app',
    scorerAppUrl: 'https://app.openvolley.app',
    // every tab of the console (ManageConsole filters by role)
    tabs: null,
    // the account lists, invites and audit of this console: ?app=indoor, so
    // OpenBeach's members, codes and entries stay out of it (plan 1.4, 1.6;
    // a 2.1/2.2 client sends no ?app= and keeps the old, unscoped answer)
    scope: 'indoor'
  }),
  beach: Object.freeze({
    app: 'beach',
    name: 'OpenBeach',
    lockup: beachLockup,
    mark: beachMark,
    siteUrl: 'https://manager-beach.openvolley.app',
    scorerAppUrl: 'https://beach.openvolley.app',
    // No official games (VolleyManager) and no closed-match list here: those
    // stay in OpenVolley's console. Tournaments: phase T1.
    tabs: Object.freeze(['accounts', 'invites', 'audit', 'activity', 'teams', 'tournaments']),
    scope: 'beach'
  })
})

/** The brand of an app name: OpenBeach for 'beach', OpenVolley for anything else. */
export function managerBrandOf(app) {
  return app === 'beach' ? MANAGER_BRANDS.beach : MANAGER_BRANDS.indoor
}

const ManagerBrandContext = createContext(MANAGER_BRANDS.indoor)

/** Sets the brand for everything below (the manager entries). */
export function ManagerBrandProvider({ app, children }) {
  return createElement(ManagerBrandContext.Provider, { value: managerBrandOf(app) }, children)
}

/** The brand of the page: OpenVolley's unless an OpenBeach manager entry set it. */
export function useManagerBrand() {
  return useContext(ManagerBrandContext)
}
