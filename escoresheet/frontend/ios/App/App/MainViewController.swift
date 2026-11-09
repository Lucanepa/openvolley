import UIKit
import Capacitor

/**
 * The app's web view (Main.storyboard). It registers the app's own plugins,
 * the iOS side of the ones in android/.../MainActivity:
 *   - "OpenVolleyFiles": Open / Share a saved scoresheet PDF
 *     (src/utils/openAppWindow.js)
 *   - "OpenVolleyBars": no status bar and no home indicator on the scoring
 *     screen of a tablet (src/utils/nativeSystemBars.js)
 * "OpenVolleyApp" (exitApp) and "UpdateSource" have no iOS side: an iOS app
 * never ends itself and the App Store updates it (the page asks for them on
 * Android only: appLifecycle.js, androidUpdate.js).
 */
class MainViewController: CAPBridgeViewController {
    private var scoringChromeHidden = false

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScoresheetFilesPlugin())
        bridge?.registerPluginInstance(ScoringBarsPlugin())
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        return scoringChromeHidden
    }

    /// The scoring screen: the status bar out of the way, the home indicator
    /// dimmed until touched (iOS keeps a swipe from the edge working).
    func setScoringChromeHidden(_ hidden: Bool) {
        scoringChromeHidden = hidden
        setStatusBarVisible(!hidden)
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }
}
