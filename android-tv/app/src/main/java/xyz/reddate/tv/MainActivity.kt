package xyz.reddate.tv

import android.graphics.Color
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import xyz.reddate.tv.ui.AppModel
import xyz.reddate.tv.ui.AppRoot
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Two layers. Underneath: Reddate's page in a WebView, the "engine" that holds the room, sync,
 * chat and account. On top: the native screens (Jetpack Compose for TV) for Home, titles, search
 * and profiles. The page says when one of its own screens must be on top instead (sign-in,
 * addons, account, chat, a YouTube video); then the WebView shows and gets the remote.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var composeView: ComposeView
    private lateinit var model: AppModel
    private var loadFailed = false
    private val webShown = mutableStateOf(true)
    private lateinit var invitePrompt: InvitePrompt

    companion object {
        @Volatile private var instance: MainActivity? = null

        /** Tell the page something happened in the native player (called from any thread). */
        fun emit(json: String) {
            val a = instance ?: return
            a.runOnUiThread { a.web.evaluateJavascript("window.ReddateTV&&window.ReddateTV.onNative&&window.ReddateTV.onNative($json)", null) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        (application as? ReddateApp)?.sendLastCrash()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        instance = this
        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        Engine.web = web
        model = AppModel(lifecycleScope)
        composeView = ComposeView(this).apply {
            setContent { AppRoot(model, webShown = webShown.value, onExit = { finish() }) }
            visibility = View.GONE
        }
        val root = FrameLayout(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(composeView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        invitePrompt = InvitePrompt(this, root)
        hideSystemBars()

        // Back on a page screen goes to the page; on a native screen Compose handles it.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (loadFailed) { finish(); return }
                web.evaluateJavascript("(function(){ if (window.ReddateTV) { window.ReddateTV.back(); return 'handled'; } return 'none'; })()") { result ->
                    if (result?.contains("none") == true) finish()
                }
            }
        })
        lifecycleScope.launch {
            Engine.events.collect { e ->
                when (e.optString("type")) {
                    "surface" -> showWeb(e.optBoolean("web"))
                    "account" -> { model.refreshInfo(); model.loadRows() }
                    "home-changed" -> model.loadRows()
                    "invite" -> onInvite(e)
                    "play-failed" -> model.onPlayFailed(e.optString("src"), e.optBoolean("host", true), e.optInt("pos", 0))
                    "pick-profile" -> { model.refreshInfo().join(); model.go(xyz.reddate.tv.ui.Screen.Profiles) }
                    "notice" -> model.say(e.optString("text"))
                    "chat-msg" -> model.onChat(e.optString("user"), e.optString("text"), e.optBoolean("self"))
                }
            }
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true // keeps the TV signed in
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString ReddateTV/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG || BuildConfig.BUILD_TYPE == "lan")
        // The page holds the room connection and must keep running even while the native player
        // covers it, so keep its renderer at high priority whether or not it is on screen.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        web.addJavascriptInterface(NativeBridge(this), "ReddateNative")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline()
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!url.startsWith("data:")) loadFailed = false
                DevLog.log("page-finished", url)
            }

            // If the system kills the page's process (low memory on a busy TV), recover instead of dying.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                DevLog.log("render-process-gone", "crashed=${detail.didCrash()}")
                runOnUiThread {
                    (view.parent as? android.view.ViewGroup)?.removeView(view)
                    view.destroy()
                    recreate()
                }
                return true
            }
        }

        if (savedInstanceState == null) web.loadUrl(BuildConfig.START_URL) else web.restoreState(savedInstanceState)
    }

    /** Watch-party invite from another of your devices: pop-up over the player if it's open, else here. */
    private fun onInvite(e: org.json.JSONObject) {
        val roomId = e.optString("roomId")
        if (roomId.isEmpty()) return
        val from = e.optString("from"); val device = e.optString("device"); val title = e.optString("title")
        PlayerActivity.current?.let { it.showInvite(roomId, from, device, title); return }
        invitePrompt.show(from, device, title) { accept ->
            lifecycleScope.launch { try { Engine.call("answerInvite", org.json.JSONObject().put("roomId", roomId).put("accept", accept)) } catch (_: Exception) { } }
        }
    }

    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        if (::invitePrompt.isInitialized && invitePrompt.visible && invitePrompt.onKey(event)) return true
        return super.dispatchKeyEvent(event)
    }

    /** Put the page's screen on top (and give it the remote), or the native screens. */
    private fun showWeb(show: Boolean) {
        val wasShown = webShown.value
        webShown.value = show
        if (show) {
            composeView.visibility = View.GONE
            web.isFocusable = true
            web.requestFocus()
        } else {
            web.isFocusable = false
            composeView.visibility = View.VISIBLE
            composeView.requestFocus()
            model.refreshInfo()
            if (wasShown) model.refocusTick++ // back from Addons/Account: focus goes back where you were
            // First time in (just signed in), or back from Addons/Account: (re)load Home.
            if (wasShown && model.rows.isEmpty()) model.loadRows() // Home edits arrive as their own event
        }
    }

    /** No connection: say so, and keep trying until it's back. */
    private fun showOffline() {
        loadFailed = true
        val page = """
            <html><body style="margin:0;background:#1c1613;color:#e8e2dd;font-family:sans-serif;
                display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center">
              <div style="color:#e8602c;font-size:40px;font-family:monospace">r/Reddate</div>
              <p style="font-size:30px">Can't reach Reddate.</p>
              <p style="font-size:22px;opacity:.7">Check the TV's internet connection. Trying again…</p>
            </body></html>
        """.trimIndent()
        web.loadDataWithBaseURL(null, page, "text/html", "utf-8", null)
        web.postDelayed({ if (loadFailed) web.loadUrl(BuildConfig.START_URL) }, 5000)
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume(); web.onResume()
        if (::model.isInitialized) {
            model.loadContinue(); model.refreshVault(); model.refreshInfo()
            val picked = PlayerActivity.pendingTitle
            if (picked != null) {
                val streams = PlayerActivity.pendingStreams
                val ep = PlayerActivity.pendingStreamsEpisode; val at = PlayerActivity.pendingStreamsAt
                PlayerActivity.pendingTitle = null; PlayerActivity.pickingVideo = false
                PlayerActivity.pendingStreams = false; PlayerActivity.pendingStreamsEpisode = ""; PlayerActivity.pendingStreamsAt = 0
                try {
                    val meta = xyz.reddate.tv.ui.parseMeta(org.json.JSONObject(picked))
                    if (streams) {
                        // "Other streams": the same title at its streams, nothing picked for you; Back goes on to Home.
                        model.go(xyz.reddate.tv.ui.Screen.Title(meta, episodeId = ep, startAt = at))
                        model.say("Pick another stream: it continues from where you were, for everyone")
                    } else {
                        model.go(xyz.reddate.tv.ui.Screen.Title(meta, autoPlay = true)); model.say("Pick a stream: it plays for everyone in the party")
                    }
                } catch (_: Exception) { }
            } else if (PlayerActivity.pickingVideo) { PlayerActivity.pickingVideo = false; model.say("Pick something: it plays for everyone in the party") }
        }
    }
    // The page keeps running while the native player is open (it holds the room connection). We only
    // pause it when the whole app goes to the background, and never while the player is up.
    override fun onStart() { super.onStart(); DevLog.log("main-onStart", ""); web.onResume() }
    override fun onStop() {
        DevLog.log("main-onStop", "player=${PlayerActivity.current != null}")
        if (PlayerActivity.current == null) web.onPause()
        super.onStop()
    }

    @Deprecated("Memory pressure is worth knowing about on a TV")
    override fun onTrimMemory(level: Int) {
        DevLog.log("trim-memory", "level=$level")
        @Suppress("DEPRECATION")
        super.onTrimMemory(level)
    }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }
    override fun onDestroy() { if (instance === this) instance = null; if (Engine.web === web) Engine.web = null; web.destroy(); super.onDestroy() }
}
