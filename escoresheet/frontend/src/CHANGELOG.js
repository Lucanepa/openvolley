// Version changelog - Update this file when releasing new versions
// Add new entries at the TOP of the array (newest first)

export const changelog = [
  {
    version: '0.11.8',
    date: '20.12.25',
    changes: [
      'Implement date and time validation in MatchSetup component'
    ]
  },
  {
    version: '0.11.7',
    date: '20.12.25',
    changes: [
      'Enhance WebSocket handling and sync queue retry logic'
    ]
  },
  {
    version: '0.11.6',
    date: '20.12.25',
    changes: [
      'Enhance CoinToss and MatchSetup components with improved validation and user feedback'
    ]
  },
  {
    version: '0.11.5',
    date: '20.12.25',
    changes: [
      'Implement asset preloading for volleyball and referee images across multiple components'
    ]
  },
  {
    version: '0.11.4',
    date: '20.12.25',
    changes: [
      'Refactor Referee and Scoreboard components for improved styling and WebSocket handling'
    ]
  },
  {
    version: '0.11.3',
    date: '20.12.25',
    changes: [
      'Enhance CORS handling and validation checks in CoinToss component'
    ]
  },
  {
    version: '0.11.2',
    date: '19.12.25',
    changes: [
      'Fix referee dashboard not receiving updates: add subscribe-match handler to backend WebSocket',
      'Add WebSocket heartbeat (ping every 25s) to keep connections alive on mobile networks',
      'Add coin toss validation: team names, officials, match info, 6+ players with numbers, coaches',
      'Fix signature button alignment in coin toss view',
      'Preload volleyball asset to prevent loading delay',
      'Remove automatic number assignment when importing players from PDF',
      'Reset referee selector search query after selection'
    ]
  },
  {
    version: '0.11.0',
    date: '19.12.25',
    changes: [
      'Add html-to-image dependency for PDF generation in scoresheet_pdf component. Enhance PDF generation with improved image capture and zoom level management. Update package version to 0.11.0 and replace mikasa_v200w.png with a new image file to avoid issues of copyright.'
    ]
  },
  {
    version: '0.10.9',
    date: '19.12.25',
    changes: [
      'Make header collapsible only on Scoreboard page'
    ]
  },
  {
    version: '0.10.8',
    date: '19.12.25',
    changes: [
      'Update styling in Scoreboard and Referee components for better visual feedback during matches. Changed background colors and border styles for recently substituted players, and added functionality to toggle between first and last names for court players. Replaced mikasa_v200w.png with a new image file to address copyright issues.'
    ]
  },
  {
    version: '0.10.7',
    date: '19.12.25',
    changes: [
      'Refactor railway.json to switch from Nixpacks to Dockerfile for building the frontend application. This change simplifies the build process and aligns with current deployment practices.'
    ]
  },
  {
    version: '0.10.6',
    date: '19.12.25',
    changes: [
      'Update railway.json to include Nixpacks configuration for Node.js and modify start command for better compatibility with environment variables. This enhances the build and deployment process for the frontend application.'
    ]
  },
  {
    version: '0.10.5',
    date: '19.12.25',
    changes: [
      'Add detailed debug logging for undo operations in Scoreboard component. Enhanced event tracing by logging current set events, sorted events, and checks for undoable events, improving traceability and error handling during match data management.'
    ]
  },
  {
    version: '0.10.4',
    date: '19.12.25',
    changes: [
      'Add detailed debug logging for undo operations in Scoreboard component. Enhanced event tracing by logging current set events, sorted events, and checks for undoable events, improving traceability and error handling during match data management.'
    ]
  },
  {
    version: '0.10.3',
    date: '19.12.25',
    changes: [
      'Add state snapshot logging to Scoreboard events for improved traceability. Enhanced event handling by including stateBefore for various actions such as rotations, set starts, and substitutions, ensuring better state management during live matches.'
    ]
  },
  {
    version: '0.10.2',
    date: '19.12.25',
    changes: [
      'Enhance MatchEntry, Referee, and Scoreboard components with improved styling for timeouts and substitutions. Updated background colors and borders based on usage thresholds to provide clearer visual feedback during matches. Refined event handling in Scoreboard for better state management and undo functionality, ensuring a more responsive user experience.'
    ]
  },
  {
    version: '0.10.1',
    date: '19.12.25',
    changes: [
      'Update package version to 0.10.0 and replace mikasa_v200w.png with a new image file to avoid issues of copyright.'
    ]
  },
  {
    version: '0.9.30',
    date: '19.12.25',
    changes: [
      'Update Scoreboard and Referee components for improved styling and functionality. Changed border colors for recently substituted players, refined event handling in Scoreboard, and removed unnecessary debug logging. Enhanced user interface elements for better clarity and responsiveness during live matches.'
    ]
  },
  {
    version: '0.9.29',
    date: '19.12.25',
    changes: [
      'Enhance Scoreboard component with improved substitution and set reopening logic. Updated confirmation messages for deletion actions, added functionality to restore lineups after substitutions, and refined the reopening process for sets, including event deletions and score adjustments. This improves match data management and user experience during live matches.'
    ]
  },
  {
    version: '0.9.28',
    date: '19.12.25',
    changes: [
      'Add detailed debug logging to Scoreboard component for undo operations. Enhanced logging includes summaries of events, last event details, substitution actions, and error handling, improving traceability during match data management.'
    ]
  },
  {
    version: '0.9.27',
    date: '19.12.25',
    changes: [
      'Add debug logging functionality to Scoreboard component. Implemented state snapshot creation for various events, including point awards, rotations, rallies, and substitutions. Added options to download and clear debug logs, enhancing debugging capabilities for match data management.'
    ]
  },
  {
    version: '0.9.26',
    date: '19.12.25',
    changes: [
      'Add menu title support in MenuList and implement options for showing player names and auto-downloading data in Scoreboard'
    ]
  },
  {
    version: '0.9.25',
    date: '19.12.25',
    changes: [
      'Refactor LivescoreApp and Scoreboard components for improved first serve logic and UI enhancements. Simplified first serve calculation based on set index and alternation pattern. Updated ScoreboardToolbar for better collapsible functionality and adjusted styles for match-toolbar. Enhanced drag-and-drop functionality for player substitutions in LineupModal, improving user experience.'
    ]
  },
  {
    version: '0.9.24',
    date: '18.12.25',
    changes: [
      'Update service worker revision and enhance CoinToss and MatchSetup components. Changed service worker revision for cache management. Improved CoinToss layout with a new MenuList for scoresheet preview and adjusted button styling in MatchSetup for better UI consistency.'
    ]
  },
  {
    version: '0.9.23',
    date: '18.12.25',
    changes: [
      'Refactor styles and CoinToss component for improved layout and responsiveness. Adjusted max-height and height properties in styles.css for better UI scaling. Updated image source and button layout in CoinToss.jsx for consistency and enhanced spacing. Modified Scoreboard.jsx for better alignment and responsive design, including grid adjustments and button styling improvements.'
    ]
  },
  {
    version: '0.9.22',
    date: '18.12.25',
    changes: [
      'Enhance line judge name formatting in FooterSection and MatchSetup components. Introduced helper functions to format names from "FirstName LastName" to "LastName FirstName" and "LastName, F." respectively, improving consistency in official name displays.'
    ]
  },
  {
    version: '0.9.21',
    date: '18.12.25',
    changes: [
      'Refactor HomePage component to conditionally render match buttons. The "Continue Match" and "Delete Match" buttons are now only displayed when there is an active match, improving UI clarity and user experience.'
    ]
  },
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
