import UIKit
import QuickLook
import Capacitor

/**
 * Open / Share a scoresheet PDF the page saved with @capacitor/filesystem
 * (src/utils/openAppWindow.js: open({ uri }) and share({ uri }), a file://
 * URI in the app's Documents). Open shows it in Quick Look (zoom, print,
 * share from there too), Share the system share sheet (Mail, AirDrop,
 * Files, ...). The iOS side of android/.../ScoresheetFilesPlugin.java.
 */
@objc(ScoresheetFilesPlugin)
public class ScoresheetFilesPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource {
    public let identifier = "ScoresheetFilesPlugin"
    public let jsName = "OpenVolleyFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    private var previewURL: URL?

    /// The call's file, or nil after rejecting the call.
    private func file(of call: CAPPluginCall) -> URL? {
        guard let text = call.getString("uri"), let url = URL(string: text), url.isFileURL else {
            call.reject("not a file URI")
            return nil
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("no such file: \(url.lastPathComponent)")
            return nil
        }
        return url
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let url = file(of: call) else { return }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no window")
                return
            }
            self.previewURL = url
            let preview = QLPreviewController()
            preview.dataSource = self
            presenter.present(preview, animated: true) { call.resolve() }
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        guard let url = file(of: call) else { return }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no window")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // iPad: the sheet is a popover and needs an anchor; the page's
            // button is not known here, so it opens in the middle
            if let popover = sheet.popoverPresentationController {
                let view = presenter.view!
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true) { call.resolve() }
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        return previewURL == nil ? 0 : 1
    }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return previewURL! as NSURL
    }
}
