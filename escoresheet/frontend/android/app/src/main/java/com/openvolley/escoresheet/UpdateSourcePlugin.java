package com.openvolley.escoresheet;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Who installed the app, so the page knows how it gets its updates
 * (src/utils/androidUpdate.js, ANDROID.md "Updates"). An app installed by an
 * F-Droid client is updated by that client: the page then never asks the
 * network on its own. A sideloaded app may check, but only after the user
 * said yes.
 *
 * Nothing here installs anything: no REQUEST_INSTALL_PACKAGES, no new
 * permission, no dependency. One APK for every channel, so the f-droid.org
 * reproducible build stays valid.
 */
@CapacitorPlugin(name = "UpdateSource")
public class UpdateSourcePlugin extends Plugin {

    static final Set<String> FDROID = new HashSet<>(Arrays.asList(
        "org.fdroid.fdroid",
        "org.fdroid.basic",
        "org.fdroid.fdroid.privileged",
        "com.looker.droidify",
        "com.machiav3lli.fdroid"
    ));

    // The system's package installer (an APK opened from the browser or a
    // file manager) and adb
    static final Set<String> SIDELOAD = new HashSet<>(Arrays.asList(
        "com.google.android.packageinstaller",
        "com.android.packageinstaller",
        "com.android.shell"
    ));

    static String familyOf(String installer, String updateOwner) {
        if ((updateOwner != null && FDROID.contains(updateOwner)) || (installer != null && FDROID.contains(installer))) {
            return "fdroid";
        }
        if (installer == null || SIDELOAD.contains(installer)) return "sideload";
        return "other";
    }

    /**
     * {installer, updateOwner, family: 'fdroid' | 'sideload' | 'other',
     * versionCode}. versionCode is the installed one, build digit included, so
     * the page also sees an Android-only rebuild of the same versionName
     * (absent when it cannot be read).
     */
    @PluginMethod
    @SuppressWarnings("deprecation") // getInstallerPackageName: Android 10 and older only
    public void getInstallSource(PluginCall call) {
        Context context = getContext();
        PackageManager pm = context.getPackageManager();
        String pkg = context.getPackageName();
        String installer = null;
        String updateOwner = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                InstallSourceInfo info = pm.getInstallSourceInfo(pkg);
                installer = info.getInstallingPackageName();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    updateOwner = info.getUpdateOwnerPackageName();
                }
            } else {
                installer = pm.getInstallerPackageName(pkg);
            }
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            // our own package is always there; anything else reads as unknown
        }
        JSObject ret = new JSObject();
        ret.put("installer", installer);
        ret.put("updateOwner", updateOwner);
        ret.put("family", familyOf(installer, updateOwner));
        long code = installedVersionCode(pm, pkg);
        if (code > 0) ret.put("versionCode", code);
        call.resolve(ret);
    }

    /**
     * Open the app's page in a store, an F-Droid repo link or the APK in the
     * browser. url: market://, fdroidrepos:// or https:// (default: this
     * app's market:// page, in the installing F-Droid client when there is
     * one). When nothing can open it, fallbackUrl (https://) instead.
     * Resolves {opened, fallback}.
     */
    @PluginMethod
    public void openStore(PluginCall call) {
        String pkg = getContext().getPackageName();
        String url = call.getString("url", "market://details?id=" + pkg);
        String fallbackUrl = call.getString("fallbackUrl");
        if (!allowed(url, true) || (fallbackUrl != null && !allowed(fallbackUrl, false))) {
            call.reject("url not allowed");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (url.startsWith("market:")) {
            String installer = installerOf(pkg);
            if (installer != null && FDROID.contains(installer)) intent.setPackage(installer);
        }
        JSObject ret = new JSObject();
        try {
            getActivity().startActivity(intent);
            ret.put("opened", true);
            ret.put("fallback", false);
        } catch (ActivityNotFoundException e) {
            boolean opened = false;
            if (fallbackUrl != null) {
                try {
                    Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(fallbackUrl));
                    web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(web);
                    opened = true;
                } catch (ActivityNotFoundException ignored) {
                    // no browser at all
                }
            }
            ret.put("opened", opened);
            ret.put("fallback", opened);
        }
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation") // PackageInfo.versionCode: Android 8.1 and older only
    private static long installedVersionCode(PackageManager pm, String pkg) {
        try {
            PackageInfo info = pm.getPackageInfo(pkg, 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return 0;
        }
    }

    private static boolean allowed(String url, boolean storeSchemes) {
        if (url == null) return false;
        String lower = url.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("https://")) return true;
        return storeSchemes && (lower.startsWith("market://") || lower.startsWith("fdroidrepos://"));
    }

    @SuppressWarnings("deprecation") // getInstallerPackageName: Android 10 and older only
    private String installerOf(String pkg) {
        PackageManager pm = getContext().getPackageManager();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                InstallSourceInfo info = pm.getInstallSourceInfo(pkg);
                String owner = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? info.getUpdateOwnerPackageName() : null;
                return owner != null && FDROID.contains(owner) ? owner : info.getInstallingPackageName();
            }
            return pm.getInstallerPackageName(pkg);
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return null;
        }
    }
}
