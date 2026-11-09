import UIKit
import Capacitor

/**
 * The app's web view (Main.storyboard). It registers the app's own plugin,
 * the iOS side of one in android/.../MainActivity:
 *   - "OpenVolleyFiles": Open / Share a saved scoresheet PDF
 *     (src/utils/openAppWindow.js)
 * The others need none here: the scoring screen's bars go through
 * Capacitor's own SystemBars on iOS (src/utils/nativeSystemBars.js), an iOS
 * app never ends itself ("OpenVolleyApp") and the App Store updates it
 * ("UpdateSource"); the page asks for those two on Android only
 * (appLifecycle.js, androidUpdate.js).
 */
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScoresheetFilesPlugin())
    }
}
