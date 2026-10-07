package com.openvolley.escoresheet;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;

/**
 * "Open" and "Share" for a scoresheet PDF the app saved
 * (src/utils/openAppWindow.js savePdf: Documents/OpenVolley/scoresheets, or
 * the app's own external folder). A local plugin: Android intents through the
 * app's FileProvider (AndroidManifest.xml, res/xml/file_paths.xml), no new
 * dependency, nothing proprietary, so the F-Droid build stays as it is.
 *
 * Only a PDF inside one of those two scoresheet folders is ever handed out:
 * the page names the file, but cannot reach anything else this way.
 */
@CapacitorPlugin(name = "OpenVolleyFiles")
public class ScoresheetFilesPlugin extends Plugin {

    static final String SUBDIR = "OpenVolley/scoresheets";

    /** The saved PDF named by a file:// URI or a path, if it is one of ours. */
    static File allowedPdf(String uriOrPath, File[] roots) throws IOException {
        if (uriOrPath == null || uriOrPath.isEmpty()) return null;
        String path = uriOrPath.startsWith("file://") ? Uri.parse(uriOrPath).getPath() : uriOrPath;
        if (path == null) return null;
        File file = new File(path).getCanonicalFile();
        if (!file.getName().toLowerCase().endsWith(".pdf") || !file.isFile()) return null;
        for (File root : roots) {
            if (root == null) continue;
            String dir = root.getCanonicalPath() + File.separator;
            if (file.getPath().startsWith(dir)) return file;
        }
        return null;
    }

    private File[] roots() {
        Context ctx = getContext();
        File documents = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
        File external = ctx.getExternalFilesDir(null);
        return new File[] {
            documents == null ? null : new File(documents, SUBDIR),
            external == null ? null : new File(external, SUBDIR)
        };
    }

    private Uri contentUri(PluginCall call) {
        try {
            File file = allowedPdf(call.getString("uri"), roots());
            if (file == null) {
                call.reject("not a saved scoresheet PDF");
                return null;
            }
            Context ctx = getContext();
            return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
        } catch (IOException | IllegalArgumentException e) {
            call.reject("cannot open the file: " + e.getMessage());
            return null;
        }
    }

    private void start(PluginCall call, Intent intent) {
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app on this device can open a PDF");
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        Uri uri = contentUri(call);
        if (uri == null) return;
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, "application/pdf");
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        start(call, Intent.createChooser(view, null));
    }

    @PluginMethod
    public void share(PluginCall call) {
        Uri uri = contentUri(call);
        if (uri == null) return;
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("application/pdf");
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri("", uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        start(call, Intent.createChooser(send, null));
    }
}
