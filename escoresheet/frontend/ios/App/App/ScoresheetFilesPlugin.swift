import UIKit
import QuickLook
import Capacitor

/**
 * Open / Share a scoresheet PDF the page saved with @capacitor/filesystem
 * (src/utils/openAppWindow.js: open({ uri }) and share({ uri }), a file://
 * URI in the app's own folder, Library/NoCloud/OpenVolley/scoresheets).
 * Open shows it in Quick Look (zoom, print, share from there too), Share the
 * system share sheet (Mail, AirDrop, Save to Files, ...): the way a PDF
 * leaves the app, whose folder the Files app does not show (owner decision
 * 9). The iOS side of android/.../ScoresheetFilesPlugin.java, with its rule:
 * only a saved PDF in an OpenVolley/scoresheets folder of this app is ever
 * handed out (allowedPdf), never a backup, a log or another file the page
 * names.
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

    /// The folder the scoresheet PDFs are saved in (openAppWindow.js PDF_SUBDIR).
    static let subdir = ["OpenVolley", "scoresheets"]
    /// What the page saves there: the PDF, and the match-end ZIP that
    /// "Share all files" writes the same way (shareFile.js); never a backup
    /// or a log, which live in other folders.
    static let types: Set<String> = ["pdf", "zip"]

    /// The saved file a file:// URL names, if it is one of ours: symlinks
    /// resolved and the path standardised first, then a regular .pdf (or the
    /// match-end .zip) directly in an OpenVolley/scoresheets folder inside
    /// `container` (the app's own: Library/NoCloud, or Documents where older
    /// versions saved it until the first start moves it). Android's
    /// allowedPdf, with the ZIP the iOS share sheet already took.
    static func allowedPdf(_ url: URL, container: URL) -> URL? {
        guard url.isFileURL else { return nil }
        let file = url.resolvingSymlinksInPath().standardizedFileURL
        guard types.contains(file.pathExtension.lowercased()) else { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else { return nil }
        let folder = file.deletingLastPathComponent().pathComponents
        guard folder.count >= subdir.count, Array(folder.suffix(subdir.count)) == subdir else { return nil }
        let root = container.resolvingSymlinksInPath().standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return file.path.hasPrefix(prefix) ? file : nil
    }

    /// The call's file, or nil after rejecting the call.
    private func file(of call: CAPPluginCall) -> URL? {
        guard let text = call.getString("uri"), let url = URL(string: text), url.isFileURL else {
            call.reject("not a file URI")
            return nil
        }
        guard let file = ScoresheetFilesPlugin.allowedPdf(url, container: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)) else {
            call.reject("not a saved scoresheet file")
            return nil
        }
        return file
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
