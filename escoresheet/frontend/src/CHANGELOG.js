// Version changelog - Update this file when releasing new versions
// Add new entries at the TOP of the array (newest first)

export const changelog = [
  {
    version: '0.9.20',
    date: '18.12.25',
    changes: [
      'Refactor test team seed data and remove unused constants from App component. Update seed keys for test teams to better reflect their roles in matches.'
    ]
  },
  {
    version: '0.9.19',
    date: '18.12.25',
    changes: [
      'Refactor App and Scoreboard components for improved responsiveness and usability. Update minimum screen size requirements, add fullscreen toggle buttons, and enhance layout for narrow mode. Adjust styles for better alignment and spacing across various screen sizes.'
    ]
  },
  {
    version: '0.9.18',
    date: '18.12.25',
    changes: [
      'Update version to 0.9.17, enhance WebSocket sync for official matches, and add cache cleared alert before page reload. Refactor sync logic to exclude test matches and clean up debug logs across components.'
    ]
  },
  {
    version: '0.9.17',
    date: '18.12.25',
    changes: [
      'Add cache cleared alert in Options before page reload',
      'Add immediate WebSocket sync after coin toss, lineup, and set start'
    ]
  },
  {
    version: '0.9.15',
    date: '18.12.25',
    changes: [
      'Downgrade incomplete WebSocket data warning to debug log'
    ]
  },
  {
    version: '0.9.13',
    date: '18.12.25',
    changes: [
      'Move version before 1R/2R toggle, make VS italic in referee view'
    ]
  },
  {
    version: '0.9.12',
    date: '18.12.25',
    changes: [
      'Add version display in Referee header next to 1R/2R toggle'
    ]
  },
  {
    version: '0.9.11',
    date: '18.12.25',
    changes: [
      'Improve referee counters: bigger, aligned, with gap, labels right-aligned'
    ]
  },
  {
    version: '0.9.10',
    date: '18.12.25',
    changes: [
      'Fix referee team row: VS centered beneath net, counters at edges, names fill space'
    ]
  },
  {
    version: '0.9.9',
    date: '18.12.25',
    changes: [
      'Allow team names to wrap to multiple lines in referee view'
    ]
  },
  {
    version: '0.9.8',
    date: '18.12.25',
    changes: [
      'Redesign referee team row: counters | name | VS | name | counters'
    ]
  },
  {
    version: '0.9.7',
    date: '18.12.25',
    changes: [
      'Remove unnecessary Clear data checkbox from UpdateBanner'
    ]
  },
  {
    version: '0.9.6',
    date: '18.12.25',
    changes: [
      'Update banner now clears cache and unregisters service workers like Options'
    ]
  },
  {
    version: '0.9.5',
    date: '18.12.25',
    changes: [
      'Fix version.json to match current version for PWA updates'
    ]
  },
  {
    version: '0.9.4',
    date: '18.12.25',
    changes: [
      'Add redirect HTML files for clean URLs without trailing slash'
    ]
  },
  {
    version: '0.9.3',
    date: '18.12.25',
    changes: [
      'Add /api/match/validate-pin endpoint to backend server'
    ]
  },
  {
    version: '0.9.1',
    date: '18.12.25',
    changes: [
      'Fix referee/bench dashboard connection toggles - now default to disabled and sync correctly',
      'Add direct WebSocket sync from MatchSetup when Scoreboard is not mounted',
      'Ensure connection settings changes propagate immediately to server'
    ]
  },
  {
    version: '0.8.17',
    date: '17.12.25',
    changes: [
      'Update version to 0.8.16, add html-to-image dependency, and enhance PDF generation features in scoresheet component.'
    ]
  },
  {
    version: '0.8.15',
    date: '17.12.25',
    changes: [
      'Refactor scoresheet components and enhance user experience with team serving logic updates.'
    ]
  },
  {
    version: '0.8.12',
    date: '16.12.25',
    changes: [
      'Update version number to 0.8.11, enhance Vite configuration for clean URL handling, and improve scoresheet PDF components with coin toss confirmation logic.'
    ]
  },
  {
    version: '0.8.28',
    date: '16.12.25',
    changes: [
      'CoinToss responsive sizing: larger elements in non-compact mode',
      'Dashboard row layout with header and vertical toggle cards'
    ]
  },
  {
    version: '0.8.26',
    date: '16.12.25',
    changes: [
      'Fix test match shortName: now correctly passes ZÜRICH/UNISG to match data',
      'Dashboard toggles: compact vertical layout with PIN below'
    ]
  },
  {
    version: '0.8.24',
    date: '16.12.25',
    changes: [
      'Dashboard Connections row between Match info/officials and Team cards',
      'Fix team shortName from testSeeds (ZÜRICH, UNISG) in test match'
    ]
  },
  {
    version: '0.8.22',
    date: '16.12.25',
    changes: [
      'Add Dashboard Connections card in MatchSetup with all dashboard toggles and PINs',
      'Auto-fill team shortName from testSeeds data in test match creation'
    ]
  },
  {
    version: '0.8.20',
    date: '16.12.25',
    changes: [
      'Split referee indicators: 1R above court, 2R below court with minimal margins',
      'Fix duplicate set index bug by improving set deduplication and creation checks'
    ]
  },
  {
    version: '0.8.16',
    date: '16.12.25',
    changes: [
      'Implement 5-column grid layout for score display with perfectly centered colon'
    ]
  },
  {
    version: '0.8.10',
    date: '16.12.25',
    changes: [
      'Update service worker revision, enhance styling in CSS, and improve MatchSetup and Scoreboard components with lineup peeking functionality and update checks.'
    ]
  },
  {
    version: '0.8.8',
    date: '15.12.25',
    changes: [
      'Implement test mode activation across multiple components for development and debugging purposes'
    ]
  },
  {
    version: '0.8.6',
    date: '15.12.25',
    changes: [
      'Implement UpdateBanner component across multiple apps and adjust Vite configuration for PWA updates'
    ]
  },
  {
    version: '0.8.4',
    date: '15.12.25',
    changes: [
      'Remove obsolete SQL files for resetting test data and schema'
    ]
  },
  {
    version: '0.8.2',
    date: '15.12.25',
    changes: [
      'Enhance GitHub Actions workflow for version checking and release management'
    ]
  },
  {
    version: '0.7.11',
    date: '14.12.25',
    changes: [
      'Add team history tables and enhance match setup with autocomplete feature'
    ]
  },
  {
    version: '0.7.9',
    date: '14.12.25',
    changes: [
      'Update settings and MainHeader component for improved functionality'
    ]
  },
  {
    version: '0.7.7',
    date: '14.12.25',
    changes: [
      'Enhance Referee component with substitution flashing effect and layout adjustments'
    ]
  },
  {
    version: '0.7.5',
    date: '14.12.25',
    changes: [
      'Update Referee component and service worker revision'
    ]
  },
  {
    version: '0.7.3',
    date: '14.12.25',
    changes: [
      'Enhance application functionality and user experience'
    ]
  },
  {
    version: '0.7.1',
    date: '13.12.25',
    changes: [
      'Update versioning and enhance print functionality in scoresheet'
    ]
  },
  {
    version: '0.6.14',
    date: '12.12.25',
    changes: [
      'Refactor App and styles for enhanced responsiveness and layout'
    ]
  },
  {
    version: '0.6.12',
    date: '12.12.25',
    changes: [
      'Enhance HomeOptionsModal with tooltip functionality and improved layout'
    ]
  },
  {
    version: '0.6.10',
    date: '12.12.25',
    changes: [
      'Update styles and layout in MatchSetup, App, and MainHeader components for improved responsiveness'
    ]
  },
  {
    version: '0.6.8',
    date: '12.12.25',
    changes: [
      'Enhance MatchSetup and App components for improved functionality'
    ]
  },
  {
    version: '0.6.4',
    date: '12.12.25',
    changes: [
      'Update CHANGELOG.js for version 0.6.3'
    ]
  },
  {
    version: '0.6.3',
    date: '12.12.25',
    changes: [
      'Update service worker revision and changelog for version 0.6.2'
    ]
  },
  {
    version: '0.6.2',
    date: '12.12.24',
    changes: [
      'Added collapsible version menu with changelog',
      'Auto-update changelog on commit'
    ]
  },
  {
    version: '0.6.1',
    date: '12.12.24',
    changes: [
      'Refactored MatchSetup and Scoreboard components for improved structure',
      'Improved responsive layout and styles',
      'Streamlined UI by removing Match Options Card'
    ]
  },
  {
    version: '0.5.0',
    date: '01.12.24',
    changes: [
      'Initial release with core scoring functionality',
      'Real-time match synchronization',
      'Connection status indicators'
    ]
  }
  // Add more versions above this line (newest first)
]

export default changelog
