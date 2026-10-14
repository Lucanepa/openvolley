package com.openvolley.escoresheet;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hides and shows the status and navigation bars for the scoring screen on a
 * tablet (src/utils/nativeSystemBars.js; MainActivity.setSystemBarsHidden).
 * Not Capacitor's own SystemBars plugin: its hide() keeps Android's default
 * behaviour, where a swipe brings the bars back for good and the page
 * shrinks under them again.
 */
@CapacitorPlugin(name = "OpenVolleyBars")
public class ScoringBarsPlugin extends Plugin {

    @PluginMethod
    public void hide(PluginCall call) {
        setHidden(call, true);
    }

    @PluginMethod
    public void show(PluginCall call) {
        setHidden(call, false);
    }

    private void setHidden(PluginCall call, boolean hidden) {
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).setSystemBarsHidden(hidden);
            call.resolve();
        });
    }
}
