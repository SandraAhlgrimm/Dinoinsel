package de.dinoinsel.game;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public final class MainActivity extends Activity {
    // A fixed HTTPS origin gives localStorage a stable home without a server or file access.
    private static final String LOCAL_ORIGIN = "https://dino-insel.invalid/";
    private static final String PAUSE_SCRIPT =
            "(function(){try{if(window.dinoApp&&typeof window.dinoApp.pause==='function')"
                    + "window.dinoApp.pause();}catch(e){"
                    + "console.error('Dino Insel: Pausieren und Speichern fehlgeschlagen.',e);}})();";
    private static final String BACK_SCRIPT =
            "(function(){try{if(window.dinoApp&&typeof window.dinoApp.handleBack==='function')"
                    + "return window.dinoApp.handleBack();}catch(e){"
                    + "console.error('Dino Insel: Zurueck-Aktion fehlgeschlagen.',e);}return null;})();";

    private WebView webView;
    private boolean resumed;
    private boolean backPending;
    private Runnable unregisterBack;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(221, 241, 208));
        webView = new WebView(this);
        configureWebView(webView);
        container.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= 28) {
            container.setOnApplyWindowInsetsListener((view, insets) -> {
                DisplayCutout cutout = insets.getDisplayCutout();
                view.setPadding(
                        cutout == null ? 0 : cutout.getSafeInsetLeft(),
                        cutout == null ? 0 : cutout.getSafeInsetTop(),
                        cutout == null ? 0 : cutout.getSafeInsetRight(),
                        cutout == null ? 0 : cutout.getSafeInsetBottom());
                return insets;
            });
        }
        setContentView(container);
        if (Build.VERSION.SDK_INT >= 33) {
            unregisterBack = ModernBack.register(this, this::handleBack);
        }
        hideSystemBars();
        webView.loadDataWithBaseURL(
                LOCAL_ORIGIN, readGame(), "text/html", "UTF-8", LOCAL_ORIGIN);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    private void configureWebView(WebView view) {
        WebView.setWebContentsDebuggingEnabled(false);
        view.setBackgroundColor(Color.rgb(221, 241, 208));
        view.setSaveEnabled(false);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setBlockNetworkImage(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSafeBrowsingEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView source, String url) {
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView source, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) {
                    return null;
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Offline only",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public void onPageFinished(WebView source, String url) {
                if (!resumed) {
                    pauseAndSave();
                }
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }

            @Override
            public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                    FileChooserParams parameters) {
                callback.onReceiveValue(null);
                return true;
            }
        });
    }

    private String readGame() {
        try (InputStream input = getAssets().open("index.html");
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new IllegalStateException("Die Spieldatei fehlt in dieser Installation.", exception);
        }
    }

    private void pauseAndSave() {
        if (webView != null) {
            webView.evaluateJavascript(PAUSE_SCRIPT, null);
        }
    }

    private void handleBack() {
        if (webView == null || backPending) {
            return;
        }
        backPending = true;
        webView.evaluateJavascript(BACK_SCRIPT, result -> {
            backPending = false;
            // Missing hooks, errors and a not-yet-loaded page must never accidentally exit.
            if ("false".equals(result) && !isFinishing()) {
                pauseAndSave();
                finish();
            }
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onPause() {
        resumed = false;
        pauseAndSave();
        if (webView != null) {
            // onPause does not suspend JavaScript, so the queued save can still finish.
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (webView != null) {
            webView.onResume();
        }
        // Resume the renderer, never the game; the player must choose to continue.
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        } else {
            pauseAndSave();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        hideSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    protected void onDestroy() {
        if (unregisterBack != null) {
            unregisterBack.run();
            unregisterBack = null;
        }
        if (webView != null) {
            ((FrameLayout) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @TargetApi(33)
    private static final class ModernBack {
        private static Runnable register(Activity activity, Runnable action) {
            OnBackInvokedCallback callback = action::run;
            OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
            dispatcher.registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            return () -> dispatcher.unregisterOnBackInvokedCallback(callback);
        }
    }
}
