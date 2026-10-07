package com.openvolley.escoresheet;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // JS: bottom edge (CSS px, WebView viewport) of the focused text field, or -1
    private static final String FOCUSED_FIELD_BOTTOM =
        "(function(){var e=document.activeElement;" +
        "if(!e||e===document.body||!(e.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)))return -1;" +
        "return e.getBoundingClientRect().bottom;})()";

    // JS: the page's Back handler on its first page (src/utils/appLifecycle.js);
    // "true" when it took the press (it closes an open dialog, or asks
    // "Exit OpenVolley?")
    private static final String PAGE_BACK =
        "(function(){try{return !!(window.__ovAndroidBack&&window.__ovAndroidBack());}" +
        "catch(e){return false;}})()";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // window.Capacitor plugin "OpenVolleyApp": exitApp() after the page asked
        registerPlugin(AppExitPlugin.class);
        // window.Capacitor plugin "UpdateSource": who installed the app, open
        // it in F-Droid (src/utils/androidUpdate.js)
        registerPlugin(UpdateSourcePlugin.class);
        // window.Capacitor plugin "OpenVolleyFiles": Open / Share a saved
        // scoresheet PDF (src/utils/openAppWindow.js)
        registerPlugin(ScoresheetFilesPlugin.class);
        super.onCreate(savedInstanceState);
        keepWebViewInsideSystemBars();
        handleBackButton();
    }

    /**
     * Back goes back inside the app (e.g. from the referee view to the
     * scorer, or out of the scoresheet's in-app view). On the first page the
     * page asks "Exit OpenVolley?" (on the scoreboard: the match is saved)
     * and only its Exit closes the app (AppExitPlugin). A page
     * without that handler (still loading, another view) keeps the old
     * behaviour: the app goes to the background, so a stray Back press
     * mid-match never closes the scorer.
     *
     * Swiping the app away in the recent apps cannot be stopped by any app
     * (an OS rule); Android's own App pinning is the tool for that (ANDROID.md).
     */
    private void handleBackButton() {
        WebView webView = getBridge().getWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                webView.evaluateJavascript(PAGE_BACK, handled -> {
                    if (!"true".equals(handled)) {
                        moveTaskToBack(true);
                    }
                });
            }
        });
    }

    /**
     * Android 15+ draws every app edge-to-edge. Older WebViews (<= 139, still
     * common on tablets) report env(safe-area-inset-*) as 0, so the web app's
     * header would sit under the status bar. Instead of relying on the
     * WebView, inset it natively: the status/navigation bar areas show the
     * white window background (dark icons, SystemBars style LIGHT).
     * capacitor.config.json sets SystemBars.insetsHandling = "disable" so
     * Capacitor does not fight this.
     *
     * The keyboard never resizes the WebView (windowSoftInputMode
     * adjustNothing): a shorter page drops below the web app's 600 px minimum
     * height and it swaps everything for its "use a larger screen" notice,
     * unmounting the form being typed in. Like Chrome, the page keeps its
     * size; the WebView is slid up just enough to show the focused field.
     */
    private void keepWebViewInsideSystemBars() {
        View container = (View) getBridge().getWebView().getParent();
        ViewCompat.setOnApplyWindowInsetsListener(container, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            if (lp.leftMargin != bars.left || lp.topMargin != bars.top
                || lp.rightMargin != bars.right || lp.bottomMargin != bars.bottom) {
                lp.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                v.setLayoutParams(lp);
            }
            boolean imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            int imeBottom = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            panFocusedFieldAboveKeyboard(v, imeVisible ? imeBottom : 0);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(container);
    }

    private void panFocusedFieldAboveKeyboard(View container, int imeBottom) {
        if (imeBottom <= 0) {
            container.setTranslationY(0);
            return;
        }
        WebView webView = getBridge().getWebView();
        webView.evaluateJavascript(FOCUSED_FIELD_BOTTOM, value -> {
            float fieldBottomCss;
            try {
                fieldBottomCss = Float.parseFloat(value);
            } catch (NumberFormatException e) {
                fieldBottomCss = -1;
            }
            if (fieldBottomCss < 0) {
                container.setTranslationY(0);
                return;
            }
            float density = getResources().getDisplayMetrics().density;
            int[] location = new int[2];
            webView.getLocationOnScreen(location);
            float webViewTop = location[1] - container.getTranslationY();
            float gap = 16 * density;
            float fieldBottom = webViewTop + fieldBottomCss * density + gap;
            float keyboardTop = getWindow().getDecorView().getHeight() - imeBottom;
            container.setTranslationY(-Math.max(0, fieldBottom - keyboardTop));
        });
    }
}
