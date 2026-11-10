package xyz.reddate.tv

import android.app.Activity
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Tracks
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import android.view.KeyEvent
import org.json.JSONObject
import java.net.URL
import kotlin.math.abs

/**
 * Full-screen native player (ExoPlayer): plays what the TV's hardware can decode, including
 * MKV, HEVC and surround audio that a web page can't. The web page stays alive underneath and
 * keeps the room in sync: it sends play/pause/seek commands in, and this reports what the
 * viewer did with the remote back out. Events caused by a room command are marked `echo` so the
 * page doesn't broadcast them again (that would make everyone's player fight over the position).
 */
class PlayerActivity : Activity() {

    companion object {
        @Volatile var current: PlayerActivity? = null
        /** Set when a host left the player to pick another video: Home says what to do. */
        @Volatile var pickingVideo = false
        /** A title picked from the player's Browse panel (a host picked something else): Home opens it on its streams. */
        @Volatile var pendingTitle: String? = null
        /** "Other streams": Home opens the title that was playing at its streams (a show at this episode), and the
         *  stream picked there starts at this position, in seconds. */
        @Volatile var pendingStreamsEpisode: String = ""
        @Volatile var pendingStreamsAt: Int = 0
        @Volatile var pendingStreams: Boolean = false
        /** Set when "Watch together" starts a video: the invite panel opens by itself once it plays. */
        @Volatile var openInviteAt = 0L
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var view: PlayerView
    private lateinit var cover: FrameLayout      // the title's artwork, shown until the first frame
    private lateinit var coverImage: ImageView
    private lateinit var coverTitle: TextView
    private lateinit var coverStatus: TextView
    private lateinit var coverTexts: LinearLayout // title + status; hidden while the controls show their own
    private lateinit var spinner: android.widget.ProgressBar
    private var switchingEpisode = false
    private var player: ExoPlayer? = null
    private lateinit var controls: PlayerControls
    lateinit var invitePrompt: InvitePrompt
    var url = ""
        private set
    var titleText = ""
        private set

    // ---- subtitles read by us (online ones): never restarts the picture, can be delayed, styled and moved ----
    var artUrl = ""                    // the title's picture, for cards that mention it
    val subs = SubtitleEngine()
    val audioTap = AudioTap()
    var subDelayMs = 0L
    private var subtitleSelection = 0
    var subtitlePersonal = false
    private var sharedSubtitleState = JSONObject().put("vtt", JSONObject.NULL).put("offset", 0)
    private var lastSubText = ""
    private var previewing = false
    private val prefs by lazy { getSharedPreferences("player", MODE_PRIVATE) }
    /** The TV chat's quick replies (3 phrases, then 5 emoji), saved as one string; empty means the defaults. */
    var quickReplies: String get() = prefs.getString("quick", "") ?: ""; set(v) { prefs.edit().putString("quick", v).apply() }
    var subSize: Int get() = prefs.getInt("subSize", 1); set(v) { prefs.edit().putInt("subSize", v).apply(); applySubtitleStyle() }
    var subPos: Int get() = prefs.getInt("subPos", 1); set(v) { prefs.edit().putInt("subPos", v).apply(); applySubtitleStyle() }
    var subColor: Int get() = prefs.getInt("subColor", 0); set(v) { prefs.edit().putInt("subColor", v).apply(); applySubtitleStyle() }
    var subBg: Int get() = prefs.getInt("subBg", 1); set(v) { prefs.edit().putInt("subBg", v).apply(); applySubtitleStyle() }
    var subFont: Int get() = prefs.getInt("subFont", 0); set(v) { prefs.edit().putInt("subFont", v).apply(); applySubtitleStyle() }

    private val subTicker = object : Runnable {
        override fun run() {
            val p = player
            if (p != null && !previewing && subs.cues.isNotEmpty()) {
                val text = subs.textAt(p.currentPosition - subDelayMs)
                if (text != lastSubText) {
                    lastSubText = text
                    view.subtitleView?.setCues(if (text.isEmpty()) emptyList() else listOf(androidx.media3.common.text.Cue.Builder().setText(text).build()))
                }
            }
            handler.postDelayed(this, 120)
        }
    }

    fun useExternalSubtitle(u: String, done: (Boolean) -> Unit) {
        val selection = ++subtitleSelection
        Thread {
            val pending = SubtitleEngine()
            val ok = pending.load(u)
            DevLog.log("sub-ext", "load ok=$ok cues=${subs.cues.size} err=${subs.lastError} url=${u.take(60)}")
            runOnUiThread {
                if (selection != subtitleSelection || isFinishing) return@runOnUiThread
                if (ok && !isFinishing) {
                    subs.useText(pending.asVtt(), u)
                    player?.let { it.trackSelectionParameters = it.trackSelectionParameters.buildUpon().setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, true).build() }
                    lastSubText = "\u0000"
                }
                done(ok)
            }
        }.start()
    }

    fun clearExternalSubtitle() {
        subtitleSelection++
        subs.clear()
        lastSubText = ""
        view.subtitleView?.setCues(emptyList())
    }

    fun shareExternalSubtitle(lang: String, label: String) {
        subtitlePersonal = true
        sharedSubtitleState = JSONObject().put("vtt", subs.asVtt()).put("key", subs.url).put("lang", lang).put("label", label).put("offset", subDelayMs / 1000.0)
        emit("subtitle") { put("state", sharedSubtitleState) }
    }

    fun shareSubtitleOff() {
        subtitlePersonal = true
        subDelayMs = 0
        sharedSubtitleState = JSONObject().put("vtt", JSONObject.NULL).put("lang", "off").put("offset", 0)
        emit("subtitle") { put("state", sharedSubtitleState) }
    }

    fun shareEmbeddedSubtitle(lang: String, label: String) {
        subtitlePersonal = true
        sharedSubtitleState = JSONObject().put("vtt", JSONObject.NULL).put("embeddedLang", lang).put("lang", lang).put("label", label).put("offset", 0)
        emit("subtitle") { put("state", sharedSubtitleState) }
    }

    fun shareSubtitleTiming() {
        subtitlePersonal = true
        sharedSubtitleState.put("offset", subDelayMs / 1000.0)
        emit("subtitle") { put("state", sharedSubtitleState) }
    }

    fun emitCurrentSubtitle() = emit("subtitle") { put("state", sharedSubtitleState) }

    fun applySharedSubtitle(state: JSONObject, own: Boolean) {
        if (!own) subtitleSelection++
        sharedSubtitleState = state
        subDelayMs = (state.optDouble("offset", 0.0) * 1000).toLong()
        if (!state.isNull("vtt") && state.optString("vtt").isNotEmpty()) {
            if (subs.useText(state.optString("vtt"), state.optString("key"))) {
                player?.let { it.trackSelectionParameters = it.trackSelectionParameters.buildUpon().setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, true).build() }
                lastSubText = "\u0000"
            }
        } else {
            subs.clear(); lastSubText = ""; view.subtitleView?.setCues(emptyList())
            player?.let { it.trackSelectionParameters = it.trackSelectionParameters.buildUpon().setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, state.optString("embeddedLang").isEmpty()).build() }
        }
    }

    fun previewSubtitles(on: Boolean) {
        previewing = on
        if (on) view.subtitleView?.setCues(listOf(androidx.media3.common.text.Cue.Builder().setText("This is how your subtitles look").build()))
        else { lastSubText = "\u0000"; if (subs.cues.isEmpty()) view.subtitleView?.setCues(emptyList()) }
    }

    fun applySubtitleStyle() {
        val sv = view.subtitleView ?: return
        val sizes = floatArrayOf(0.8f, 1.15f, 1.5f, 1.9f)
        val pos = floatArrayOf(0.02f, 0.08f, 0.14f, 0.22f, 0.32f)
        val colors = intArrayOf(Color.WHITE, 0xFFFFE066.toInt(), 0xFF7FE3FF.toInt(), 0xFF9DFF9D.toInt())
        val fonts = arrayOf(android.graphics.Typeface.SANS_SERIF, android.graphics.Typeface.SERIF, android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.create("casual", android.graphics.Typeface.NORMAL))
        val (bg, edge, edgeColor) = when (subBg.coerceIn(0, 3)) {
            0 -> Triple(Color.TRANSPARENT, androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK)
            1 -> Triple(0xB0000000.toInt(), androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK)
            2 -> Triple(Color.TRANSPARENT, androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK)
            else -> Triple(Color.TRANSPARENT, androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, Color.BLACK)
        }
        sv.setApplyEmbeddedStyles(false)
        sv.setApplyEmbeddedFontSizes(false)
        sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * sizes[subSize.coerceIn(0, 3)])
        sv.setBottomPaddingFraction(pos[subPos.coerceIn(0, 4)])
        sv.setStyle(androidx.media3.ui.CaptionStyleCompat(colors[subColor.coerceIn(0, 3)], bg, Color.TRANSPARENT, edge, edgeColor, fonts[subFont.coerceIn(0, 3)]))
    }

    private var readySent = false
    private var sid = "" // which playback session this is; the page ignores events from older ones

    // What a room command asked for, so its side-effect isn't reported as the viewer's own action.
    private var expectPlayWhenReady: Boolean? = null
    private var expectSeekMs: Long? = null

    // A link that never answers must not leave the picture loading for ever: after a while it counts as failed
    // (the app then tries the next closest stream, from the same place).
    private var openedAt = 0L
    private var bufferingSince = 0L
    private var stuckReported = false
    private val STUCK_START_MS = 25_000L
    private val STUCK_STALL_MS = 30_000L

    private fun reportStuck(why: String) {
        if (stuckReported || isFinishing) return
        stuckReported = true
        DevLog.log("stuck", why)
        coverStatus.text = "That stream isn't responding. Trying another…"
        cover.animate().cancel(); cover.alpha = 1f; cover.visibility = View.VISIBLE
        spinner.visibility = View.VISIBLE
        view.visibility = View.INVISIBLE
        controls.hideBar()
        emit("error") { put("code", "TIMEOUT"); put("message", why) }
        // If no other link takes over (a new playback resets this), say so rather than spin for ever.
        handler.postDelayed({
            if (stuckReported && !isFinishing) {
                coverStatus.text = "That stream isn't responding. Press Back and pick another."
                spinner.visibility = View.GONE
            }
        }, 7_000)
    }

    private val ticker = object : Runnable {
        override fun run() {
            val pl = player
            if (pl != null && !stuckReported) {
                val now = android.os.SystemClock.uptimeMillis()
                if (!readySent && openedAt > 0 && now - openedAt > STUCK_START_MS) reportStuck("never became ready in ${STUCK_START_MS / 1000}s")
                if (pl.playbackState == Player.STATE_BUFFERING && readySent) {
                    if (bufferingSince == 0L) bufferingSince = now
                    else if (now - bufferingSince > STUCK_STALL_MS) reportStuck("stalled ${STUCK_STALL_MS / 1000}s")
                } else bufferingSince = 0L
            }
            emit("tick") { put("posMs", player?.currentPosition ?: 0L); put("playing", player?.playWhenReady ?: false); put("buffering", player?.playbackState == Player.STATE_BUFFERING) }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Edge to edge: the picture may use the whole panel, including any area a TV marks as a cut-out.
        window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
        if (android.os.Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        view = PlayerView(this).apply {
            resizeMode = if (prefs.getBoolean("fill", false)) androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM else androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
            setBackgroundColor(Color.TRANSPARENT)
            setShutterBackgroundColor(Color.TRANSPARENT) // let the artwork show through until video arrives
            useController = false // our own TV controls (PlayerControls)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
        }
        coverImage = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        val shade = View(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xF0000000.toInt(), 0x66000000, 0x00000000))
        }
        coverTitle = TextView(this).apply { setTextColor(Color.WHITE); textSize = 30f; setTypeface(typeface, android.graphics.Typeface.BOLD) }
        coverStatus = TextView(this).apply { setTextColor(0xDDFFFFFF.toInt()); textSize = 18f; text = "Loading stream…" }
        spinner = android.widget.ProgressBar(this).apply {
            indeterminateTintList = android.content.res.ColorStateList.valueOf(0xFFFF6A32.toInt())
        }
        coverTexts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(72, 0, 72, 64)
            addView(spinner, LinearLayout.LayoutParams(72, 72).apply { bottomMargin = 18 })
            addView(coverTitle)
            addView(coverStatus)
        }
        cover = FrameLayout(this).apply {
            addView(coverImage, FrameLayout.LayoutParams(-1, -1))
            addView(shade, FrameLayout.LayoutParams(-1, -1))
            addView(coverTexts, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(cover, FrameLayout.LayoutParams(-1, -1))
            addView(view, FrameLayout.LayoutParams(-1, -1))
        }
        root.isFocusable = true
        setContentView(root)
        controls = PlayerControls(this, root, { player }) { px ->
            view.subtitleView?.animate()?.translationY(-px.toFloat() * 0.85f)?.setDuration(180)?.start()
            // The cover's own title and status would sit under the bar's and overlap it.
            coverTexts.animate().alpha(if (px > 0) 0f else 1f).setDuration(150).start()
        }
        invitePrompt = InvitePrompt(this, root)
        hideSystemBars()
        current = this
        applySubtitleStyle()
        handler.post(subTicker)
        start(intent)
    }

    override fun onStart() { super.onStart(); DevLog.log("player-onStart", sid) }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        start(intent)
    }

    private fun start(i: Intent) {
        val u = i.getStringExtra("url")
        if (u.isNullOrEmpty()) { finish(); return }
        release()
        url = u
        titleText = i.getStringExtra("title") ?: ""
        controls.reset(titleText)
        subtitleSelection++
        subtitlePersonal = false
        sharedSubtitleState = JSONObject().put("vtt", JSONObject.NULL).put("offset", 0)
        subs.clear(); subDelayMs = 0L; lastSubText = ""
        controls.subPref = i.getStringExtra("subPref") ?: ""
        controls.chatOn = i.getBooleanExtra("chatOn", true)
        artUrl = i.getStringExtra("art") ?: ""
        showCover(i.getStringExtra("art"), i.getStringExtra("title"))
        sid = i.getStringExtra("sid") ?: ""
        readySent = false
        view.visibility = View.VISIBLE
        switchingEpisode = false
        expectPlayWhenReady = null
        expectSeekMs = null
        endHandled = false

        // Software decoders for audio the TV's chip can't do (Dolby Digital, DTS…) are added when available.
        val renderers = object : DefaultRenderersFactory(this) {
            // The sound passes through our listener on its way to the speakers (it only measures loudness).
            override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): androidx.media3.exoplayer.audio.AudioSink? =
                androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioProcessors(arrayOf<androidx.media3.common.audio.AudioProcessor>(audioTap))
                    .build()
        }
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        val p = ExoPlayer.Builder(this, renderers)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguages(java.util.Locale.getDefault().language, "eng", "en").build()
        p.setMediaItem(mediaItem(emptyList()))
        openedAt = android.os.SystemClock.uptimeMillis(); stuckReported = false; bufferingSince = 0L
        p.playWhenReady = i.getBooleanExtra("playWhenReady", false)
        p.addListener(listener)
        p.prepare()
        val startMs = i.getLongExtra("startMs", 0L)
        if (startMs > 0) {
            p.seekTo(startMs)
            if (startMs > 10_000) { // joining part-way: say so, a far seek in a big file can take a few seconds
                val s = startMs / 1000
                coverStatus.text = "Joining at ${if (s >= 3600) "${s / 3600}:" else ""}${(s % 3600 / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}…"
            }
        }
        view.player = p
        player = p
        handler.removeCallbacks(ticker)
        handler.postDelayed(ticker, 1000)
    }

    private fun mediaItem(subs: List<JSONObject>): MediaItem = MediaItem.Builder()
        .setUri(url)
        .setMediaMetadata(MediaMetadata.Builder().setTitle(titleText).build())
        .setSubtitleConfigurations(subs.map { s ->
            val u = s.optString("url")
            MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(u))
                .setId("online:$u")
                .setMimeType(if (u.contains(".vtt", true)) MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage(s.optString("lang"))
                .setLabel(s.optString("label"))
                .build()
        })
        .build()

    /** Add online subtitles: the player reloads the stream with them, keeping the position. */
    fun reloadWithSubtitles(subs: List<JSONObject>) {
        val p = player ?: return
        val pos = p.currentPosition
        p.setMediaItem(mediaItem(subs), pos)
        p.prepare()
    }

    /** "Fill the screen": zoom the picture so there are no black bars (widescreen films lose a little at the sides). */
    var fillScreen: Boolean
        get() = prefs.getBoolean("fill", false)
        set(on) {
            prefs.edit().putBoolean("fill", on).apply()
            view.resizeMode = if (on) androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM else androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
        }

    fun emitAction(action: String) = emit("action") { put("action", action) }
    fun emitSubPref(lang: String) = emit("subpref") { put("lang", lang) }
    fun emitAudioChoice(language: String, label: String, index: Int) = emit("audio") {
        put("state", JSONObject().put("language", language).put("label", label).put("index", index))
    }
    private var endHandled = false

    /** The video reached its end: tell the page, and let the controls start the next episode if that's wanted. */
    private fun videoEnded(p: Player) {
        if (endHandled) return
        endHandled = true
        val auto = controls.willAutoPlayNext()
        emit("ended") { put("posMs", p.currentPosition); put("auto", auto) }
        if (auto) controls.autoPlayNext()
    }

    /** A host goes back to the menus to pick something else; the party stays, and what they pick plays for everyone. */
    fun changeVideo() { pickingVideo = true; finish() }
    /** Where the picture is now, in seconds. */
    fun positionSec(): Int = ((player?.currentPosition ?: 0L) / 1000L).toInt()
    fun emitSyncAnswer(yes: Boolean) = emit("sync-answer") { put("yes", yes) }

    /** Leave the room (ending it for everyone if you're the host) and go back to Home. */
    fun leaveAndClose() {
        emit("leave-room") { }
        finish()
    }

    fun emitAutoNext(on: Boolean) = emit("autonext") { put("on", on) }
    fun emitChat(text: String) = emit("chat") { put("text", text.take(500)) }
    fun emitTyping(on: Boolean) = emit("typing") { put("on", on) }
    fun emitBurst(e: String) = emit("burst") { put("e", e) }
    /** The viewer picked another episode: stop the old picture at once and show that something is loading. */
    fun emitEpisode(id: String, label: String = "") {
        switchingEpisode = true
        expectPlayWhenReady = false // our own pause, not the viewer's: the room must not hear it
        player?.let { it.pause(); it.volume = 0f }
        controls.hideBar()
        view.visibility = View.INVISIBLE
        coverTitle.text = label.ifEmpty { titleText }
        coverStatus.text = "Starting…"
        spinner.visibility = View.VISIBLE
        cover.animate().cancel()
        cover.alpha = 0f
        cover.visibility = View.VISIBLE
        cover.animate().alpha(1f).setDuration(220).start()
        emit("episode") { put("id", id) }
        // If nothing starts (no streams, not the host, the page gave up), don't sit on "Starting…" for ever.
        val mark = ++episodeToken
        handler.postDelayed({ if (mark == episodeToken && switchingEpisode) episodeFailed("Couldn't start that episode. Pick another or try again.") }, 40_000)
    }

    private var episodeToken = 0

    /** The episode switch didn't happen: bring the picture back and say why. */
    fun episodeFailed(msg: String) {
        if (!switchingEpisode) return
        switchingEpisode = false
        episodeToken++
        view.visibility = View.VISIBLE
        player?.volume = 1f
        cover.animate().cancel()
        cover.animate().alpha(0f).setDuration(200).withEndAction { cover.visibility = View.GONE; spinner.visibility = View.GONE }.start()
        controls.showToast(msg)
    }
    fun emitKick(id: String) = emit("kick") { put("id", id) }
    fun emitSetHost(id: String, on: Boolean) = emit("set-host") { put("id", id); put("on", on) }
    /** A watch-party invite arrived while watching. */
    fun showInvite(roomId: String, from: String, device: String, title: String) {
        invitePrompt.show(from, device, title) { accept -> emit("invite-answer") { put("roomId", roomId); put("accept", accept) } }
    }
    fun emitChatPref(on: Boolean) = emit("chatpref") { put("on", on) }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (::invitePrompt.isInitialized && invitePrompt.visible) { if (invitePrompt.onKey(event)) return true; return super.dispatchKeyEvent(event) }
        if (::controls.isInitialized && controls.onKey(event)) return true
        return super.dispatchKeyEvent(event)
    }

    private val listener = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) { controls.onTracksChanged() }

        override fun onPlaybackStateChanged(state: Int) {
            val p = player ?: return
            if (state == Player.STATE_READY && !readySent) {
                readySent = true
                emit("ready") { put("durationMs", p.duration.coerceAtLeast(0L)) }
                controls.autoPickPreferred()
                controls.warmPreviews()
                controls.showBar() // a moment with the title and options when playback starts
                // Started with "Watch together": the invite (code, QR, your other devices) comes up and stays.
                if (openInviteAt > 0 && android.os.SystemClock.uptimeMillis() - openInviteAt < 120_000) {
                    openInviteAt = 0
                    handler.postDelayed({ controls.openPanel("invite") }, 900)
                }
            }
            if (state == Player.STATE_ENDED) videoEnded(p)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val echo = expectPlayWhenReady == playWhenReady
            if (echo) expectPlayWhenReady = null
            emit("state") { put("playing", playWhenReady); put("posMs", player?.currentPosition ?: 0L); put("echo", echo) }
            controls.updatePlayChip()
            if (!playWhenReady && readySent && !switchingEpisode) controls.showBar() // paused: show where we are, like any TV player
        }

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            if (reason != Player.DISCONTINUITY_REASON_SEEK) return
            // A seek that lands where a room command asked is the room's own (or the end of the video, when the
            // player clamped it). Anything else is the viewer's, even right after a room command: otherwise a
            // slide made just after the room nudged the player is swallowed and the room pulls them back.
            val want = expectSeekMs
            val dur = player?.duration ?: 0L
            val echo = want != null && (Math.abs(newPosition.positionMs - want) < 3000 || (dur > 0 && want >= dur - 3000 && newPosition.positionMs >= dur - 3000))
            if (echo) expectSeekMs = null
            emit("seek") { put("posMs", newPosition.positionMs); put("echo", echo) }
        }

        override fun onPlayerError(error: PlaybackException) {
            // Some hosts close the connection at the very end instead of finishing cleanly: that is the end, not a failure.
            val p = player
            if (p != null && p.duration > 0 && p.currentPosition >= p.duration - 8_000 && !endHandled) { videoEnded(p); return }
            // Bring the cover back (it may have faded out) so the viewer sees why, not a black screen.
            val decoding = error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED || error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
            coverStatus.text = if (decoding) "This device can't decode that video (often 4K). Press Back and pick a 1080p stream."
                else "This TV can't play that stream. Press Back and pick another."
            cover.animate().cancel()
            cover.alpha = 1f
            cover.visibility = View.VISIBLE
            spinner.visibility = View.GONE
            view.visibility = View.INVISIBLE // its video surface is opaque black once playback has failed
            controls.hideBar()
            emit("error") { put("code", error.errorCodeName); put("message", error.message ?: "") }
        }

        override fun onRenderedFirstFrame() {
            cover.animate().alpha(0f).setDuration(400).withEndAction { cover.visibility = View.GONE; spinner.visibility = View.GONE }.start()
        }
    }

    /** Artwork + title behind the player until the first frame (only https images). */
    private fun showCover(art: String?, title: String?) {
        cover.animate().cancel()
        cover.alpha = 1f
        cover.visibility = View.VISIBLE
        coverTitle.text = title ?: ""
        spinner.visibility = View.VISIBLE
        coverStatus.text = "Loading stream…"
        coverImage.setImageDrawable(null)
        if (art.isNullOrEmpty() || !art.startsWith("https://")) return
        Thread {
            try {
                val bmp = URL(art).openStream().use { BitmapFactory.decodeStream(it) }
                runOnUiThread { if (!isFinishing) coverImage.setImageBitmap(bmp) }
            } catch (_: Exception) { /* no artwork is fine */ }
        }.start()
    }

    /** The viewer's own seek: never mistaken for a room command's echo. */
    fun userSeek(ms: Long) {
        expectSeekMs = null
        val p = player ?: return
        val from = p.currentPosition
        p.seekTo(ms)
        // A far jump that lands back at the start means this stream can't seek: go back to where they were and say why.
        if (ms > 60_000L) handler.postDelayed({
            val q = player ?: return@postDelayed
            if (q.currentPosition < 5_000L) controls.showToast("This stream can’t skip ahead, so it started over. Pick another stream to jump around.")
        }, 2500)
    }

    /** A command from the page (the room): play, pause, seek, or stop. */
    fun handle(cmd: JSONObject) {
        val p = player ?: return
        when (cmd.optString("cmd")) {
            "play" -> { expectPlayWhenReady = if (p.playWhenReady) null else true; p.play() }
            "pause" -> { expectPlayWhenReady = if (!p.playWhenReady) null else false; p.pause() }
            "seek" -> {
                // Mid-slide the viewer's own choice wins: a nudge from the room would drag the cursor back.
                if (controls.scrubbing()) return
                val ms = cmd.optLong("ms", 0L)
                expectSeekMs = ms
                handler.postDelayed({ if (expectSeekMs == ms) expectSeekMs = null }, 3000)
                p.seekTo(ms)
            }
            "stop" -> finish()
            "rate" -> p.setPlaybackSpeed(cmd.optDouble("r", 1.0).toFloat().coerceIn(0.8f, 1.25f))
            "info" -> cmd.optJSONObject("info")?.let { controls.setInfo(it) }
            "toast" -> controls.showToast(cmd.optString("text").take(120))
            "presence" -> controls.presence(cmd.optString("text").take(80))
            "episode-failed" -> episodeFailed(cmd.optString("text").ifEmpty { "Couldn't start that episode." }.take(120))
            "ask-sync" -> invitePrompt.ask("WATCH PARTY", "Sync with ${cmd.optString("host")}?", "${cmd.optString("host")} is at ${cmd.optString("at")}.", "Sync", "Keep watching") { yes -> emit("sync-answer") { put("yes", yes) } }
            "ask-join" -> invitePrompt.ask("WATCH PARTY", "${cmd.optString("host")} switched to ${cmd.optString("title")}", "Join them?", "Join", "Stay here") { yes -> emit("join-answer") { put("yes", yes) } }
            "burst" -> controls.burstReaction(cmd.optString("e").take(12), cmd.optString("by").take(30))
            "typing" -> controls.onTyping(cmd.optString("user"), cmd.optBoolean("on"))
            "chat" -> controls.onChat(cmd.optString("user"), cmd.optString("text").take(500), cmd.optBoolean("self"), cmd.optString("rname"), cmd.optString("rtext"))
            "pin" -> controls.onPin(cmd.optBoolean("on"), cmd.optString("name"), cmd.optString("text"), cmd.optBoolean("img"), cmd.optString("by"))
        }
    }

    private fun emit(type: String, fill: JSONObject.() -> Unit) {
        val o = JSONObject().put("type", type).put("sid", sid)
        o.fill()
        if (type != "tick") DevLog.log("player-$type", o.toString())
        MainActivity.emit(o.toString())
    }

    private fun release() {
        player?.let { it.removeListener(listener); it.release() }
        player = null
        view.player = null
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

    override fun onStop() {
        // Home was pressed or something took over: stop playing (the room keeps going without us).
        // Only a pause the viewer caused counts as theirs; this one is reported with the player closing.
        expectPlayWhenReady = false
        player?.pause()
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        controls.release()
        release()
        if (current === this) current = null
        emit("closed") { }
        super.onDestroy()
    }
}
