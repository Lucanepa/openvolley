// Box contract of the database pickers (referee database, saved teams).
//
// A picker must keep one size from its first frame to the end: the panel's
// width comes from the kit Modal (`w-full max-w-*`, never the content), and the
// result area below the search has a FIXED height that the loading skeleton,
// the empty / error message and the list all fill alike. The result area
// scrolls on its own; the search field above it stays put.
//
// (The referee picker used to size itself from its rows — 300 to 400px wide,
// 114px while loading, up to 400px tall with rows — and ran the legacy
// `rollDown` animation, which scaled it from 1.2 to 1.5 and then snapped it
// back to 1: the "opens, gets bigger, then becomes smaller" of the owner's
// report.)
//
// h-72 = 18rem. On a short screen the kit panel's max-h-[85vh] still wins: its
// body scrolls instead, and the box keeps its size while data arrives.
export const PICKER_RESULTS = 'h-72 shrink-0 overflow-y-auto overscroll-contain'
