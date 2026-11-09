import UIKit
import Capacitor

/**
 * hide() / show() from src/utils/nativeSystemBars.js: the scoring screen on a
 * tablet asks for the status bar and the home indicator to go
 * (MainViewController.setScoringChromeHidden). The iOS side of
 * android/.../ScoringBarsPlugin.java.
 */
@objc(ScoringBarsPlugin)
public class ScoringBarsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScoringBarsPlugin"
    public let jsName = "OpenVolleyBars"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise)
    ]

    @objc func hide(_ call: CAPPluginCall) {
        set(hidden: true, call)
    }

    @objc func show(_ call: CAPPluginCall) {
        set(hidden: false, call)
    }

    private func set(hidden: Bool, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            (self.bridge?.viewController as? MainViewController)?.setScoringChromeHidden(hidden)
            call.resolve()
        }
    }
}
