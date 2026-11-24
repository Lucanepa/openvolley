import UIKit
import Capacitor

/**
 * The app's data stays on this device (owner decision 9, SEC-52, as
 * android/.../data_extraction_rules.xml on Android): no iCloud backup, no
 * computer (Finder / iTunes) backup, so a second iPad set up from a club
 * iPad's backup does not open with the first scorer's session and device id,
 * and an unencrypted computer backup holds no rosters or PINs.
 *
 * isExcludedFromBackup on each folder the app or its web view writes: the
 * web view's storage (Library/WebKit: localStorage with the session, the
 * match database, the PINs), the files (Library/NoCloud: backups, logs,
 * scoresheet PDFs, src/utils/nativeBackup/platform.js), the other Library
 * folders (cookies, preferences, Application Support) and Documents (what
 * older versions left there until the first start moves it). Library/Caches
 * is never backed up. Set at every launch and when the app goes to the
 * background (SceneDelegate), so a folder made during a run is covered too.
 */
enum AppData {
    static func excludeFromBackup() {
        let fm = FileManager.default
        guard let library = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
        var folders: [URL] = []
        // made here if they are not there yet, so they are excluded before the first write
        for name in ["NoCloud", "WebKit"] {
            let url = library.appendingPathComponent(name, isDirectory: true)
            try? fm.createDirectory(at: url, withIntermediateDirectories: true)
            folders.append(url)
        }
        if let children = try? fm.contentsOfDirectory(at: library, includingPropertiesForKeys: [.isDirectoryKey]) {
            for url in children where url.lastPathComponent != "Caches" {
                if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
                    folders.append(url)
                }
            }
        }
        if let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first {
            folders.append(documents)
        }
        for folder in folders {
            exclude(folder)
        }
    }

    private static func exclude(_ folder: URL) {
        var url = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try url.setResourceValues(values)
        } catch {
            NSLog("[AppData] cannot exclude %@ from backups: %@", folder.lastPathComponent, error.localizedDescription)
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppData.excludeFromBackup()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
