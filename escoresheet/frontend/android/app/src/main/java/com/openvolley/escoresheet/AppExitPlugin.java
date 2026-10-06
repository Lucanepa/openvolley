package com.openvolley.escoresheet;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page's "Exit" after it asked "Exit OpenVolley?" on the Back button
 * (src/utils/appLifecycle.js; MainActivity.handleBackButton). A local plugin,
 * not @capacitor/app: one method, no new dependency.
 */
@CapacitorPlugin(name = "OpenVolleyApp")
public class AppExitPlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }
}
