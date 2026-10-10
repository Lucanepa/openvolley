// The browsers the build lowers its JavaScript and CSS for (vite.config.js and
// scripts/build-subdomains.js): Vite 7's defaults. Vite 8 raised them to
// Chrome 111 / Safari 16.4; these keep every tablet and WebView that ran the
// app before the update working after it.
export const BUILD_TARGET = ['chrome107', 'edge107', 'firefox104', 'safari16']
