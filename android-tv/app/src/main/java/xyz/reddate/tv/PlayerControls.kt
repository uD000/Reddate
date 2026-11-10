package xyz.reddate.tv

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.content.res.ColorStateList
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.exoplayer.ExoPlayer
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The TV player's own controls, the Android TV way: a bar along the bottom (title, progress,
 * and a row of options) and a side panel for each option (subtitles, audio, invite, who's here).
 * The remote: OK shows the bar, Left/Right skip 10 seconds, Back closes whatever is open.
 */
class PlayerControls(
    private val activity: PlayerActivity,
    private val root: FrameLayout,
    private val playerOf: () -> ExoPlayer?,
    /** Lift subtitles by this many pixels (0 = normal) so the bar never covers them. */
    private val liftSubtitles: (Int) -> Unit = {}
) {
    companion object {
        private const val ACCENT = 0xFFFF6A32.toInt()
        private const val INK = 0xFF101010.toInt()
        private const val SURFACE = 0xA6100D0C.toInt() // see-through: the video (and its subtitles) stay visible
        private const val MUTED = 0xB3FFFFFF.toInt()
        private const val HIDE_AFTER_MS = 5000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private val density = activity.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    // What the room tells us (from the page): the invite link, who's here, online subtitles.
    private var info = JSONObject()
    var subPref = ""                                     // the language this viewer last picked
    var chatOn = true                                    // show new chat messages over the video
    private class ChatLine(val who: String, val text: String, val rName: String = "", val rText: String = "")
    private val chatLog = ArrayDeque<ChatLine>() // newest last
    private var pinned: Triple<String, String, String>? = null // (name, text, who pinned)
    private lateinit var chatStack: LinearLayout
    private lateinit var chatChip: TextView
    private var chatUnread = 0
    private val typingNow = LinkedHashMap<String, Runnable>() // who is typing, each with the timer that clears them
    private var typingView: TextView? = null
    private var iAmTyping = false
    private var inviteShown = false
    private var chatDraft = ""
    private var chatInput: EditText? = null
    private lateinit var behindPill: TextView
    private var behindShown = false

    private val bar: LinearLayout
    private val title: TextView
    private val meta: TextView
    private val progress: ScrubBar
    private val time: TextView
    private val seekRow: LinearLayout
    private val chips: LinearLayout
    private val playChip: TextView
    private lateinit var browseChip: TextView
    private lateinit var syncChip: TextView
    private lateinit var sleepChip: TextView
    private lateinit var whoPill: LinearLayout
    private var kickTarget: Pair<String, String>? = null // (socket id, name) waiting for a yes
    private var episodeSeason = -1
    private val panel: LinearLayout
    private val panelTitle: TextView
    private val panelList: LinearLayout
    /** Above the scrolling list: rows that stay put (the Episodes panel's autoplay switch and seasons). */
    private val panelFixed: LinearLayout
    private lateinit var panelScroll: ScrollView
    /** Second column, used by Subtitles: the settings beside the language list. */
    private val panelSide: LinearLayout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private lateinit var sideScroll: ScrollView
    private var panelBg: android.graphics.drawable.Drawable? = null
    private var panelKind = ""

    private val hideRunnable = Runnable { hideBar() }
    private val progressRunnable = object : Runnable {
        override fun run() { updateProgress(); handler.postDelayed(this, 500) }
    }

    init {
        title = text(32f, Color.WHITE, bold = true).apply {
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            // The title in the app's display face (Bricolage Grotesque, extra bold), as on every other screen.
            val face = androidx.core.content.res.ResourcesCompat.getFont(activity, xyz.reddate.tv.R.font.bricolage)
            if (face != null) typeface = if (android.os.Build.VERSION.SDK_INT >= 28) Typeface.create(face, 800, false) else Typeface.create(face, Typeface.BOLD)
            letterSpacing = -0.02f
        }
        meta = text(15f, MUTED)
        progress = ScrubBar(activity, ACCENT)
        time = text(15f, MUTED).apply { setPadding(dp(16), 0, 0, 0) }
        // The progress row is focusable: with it selected, Left/Right skip.
        seekRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            setPadding(dp(12), dp(6), dp(12), dp(6))
            // no box around the row: the handle on the bar shows where you are
            setOnFocusChangeListener { _, has -> progress.setSelectedLook(has); time.setTextColor(if (has) Color.WHITE else MUTED); time.textSize = if (has) 17f else 15f }
            addView(progress, LinearLayout.LayoutParams(0, dp(26), 1f))
            addView(time)
        }
        chips = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        chips.gravity = Gravity.CENTER_VERTICAL
        // One short row: back 10 s, play/pause, forward 10 s; then Subtitles (CC) and an icon each for sound, chat,
        // sleep timer, people (who's here and invite), sync (in a party) and Browse (episodes, suggestions, search).
        chips.addView(roundChip("−10", 44) { skip(-10_000L); scheduleHide() })
        playChip = roundChip("❚❚", 52) { togglePlay() }
        chips.addView(playChip)
        chips.addView(roundChip("+10", 44) { skip(10_000L); scheduleHide() }.apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(22) })
        chips.addView(chip("CC") { openPanel("subs") }.apply { contentDescription = "Subtitles"; setPadding(dp(16), dp(0), dp(16), dp(0)); gravity = Gravity.CENTER; layoutParams = LinearLayout.LayoutParams(-2, dp(48)).apply { rightMargin = dp(10) } })
        chips.addView(iconChip(R.drawable.ic_audio, "Audio") { openPanel("audio") })
        chatChip = iconChip(R.drawable.ic_chat, "Chat") { openPanel("chat") }
        chips.addView(chatChip)
        sleepChip = iconChip(R.drawable.ic_sleep, "Sleep timer") { openPanel("sleep") }
        chips.addView(sleepChip)
        chips.addView(iconChip(R.drawable.ic_people, "Who's here and invite") { openPanel("people") })
        syncChip = iconChip(R.drawable.ic_sync, "Sync") { onSyncPressed() }.apply { visibility = View.GONE }
        chips.addView(syncChip)
        browseChip = iconChip(R.drawable.ic_browse, "Browse") { openPanel("browse") }
        chips.addView(browseChip)

        bar = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48), dp(56), dp(48), dp(28))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xF0000000.toInt(), 0xAA000000.toInt(), 0x00000000))
            addView(title)
            addView(meta, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(10) })
            addView(seekRow, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = -dp(12); rightMargin = -dp(12) })
            addView(android.widget.HorizontalScrollView(activity).apply { isHorizontalScrollBarEnabled = false; clipToPadding = false; addView(chips) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
            visibility = View.GONE
        }
        root.addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))

        panelTitle = text(22f, Color.WHITE, bold = true).apply { setPadding(0, 0, 0, dp(16)) }
        panelList = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        panelFixed = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(36), dp(28), dp(28))
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(0x40100D0C, SURFACE, 0xCC100D0C.toInt()))
            addView(panelTitle)
            addView(panelFixed)
            panelScroll = ScrollView(activity).apply { isVerticalScrollBarEnabled = false; addView(panelList) }
            sideScroll = ScrollView(activity).apply { isVerticalScrollBarEnabled = false; addView(panelSide); visibility = View.GONE }
            val cols = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(panelScroll, LinearLayout.LayoutParams(0, -1, 1f))
                addView(sideScroll, LinearLayout.LayoutParams(dp(330), -1).apply { leftMargin = dp(28) })
            }
            addView(cols, LinearLayout.LayoutParams(-1, 0, 1f))
            visibility = View.GONE
        }
        root.addView(panel, FrameLayout.LayoutParams(dp(340), -1, Gravity.END))

        // Chat pop-ups: top right, see-through, gone after a few seconds.
        chatStack = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        root.addView(chatStack, FrameLayout.LayoutParams(dp(300), -2, Gravity.END or Gravity.TOP).apply { topMargin = dp(24); rightMargin = dp(24) })

        // "You're behind" prompt: top left, stays until you press OK (or catch up by yourself).
        behindPill = text(15f, Color.WHITE, bold = true).apply {
            setPadding(dp(16), dp(10), dp(16), dp(10))
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(0xEE0D0B0A.toInt()); setStroke(dp(2), ACCENT) }
            visibility = View.GONE
            elevation = dp(6).toFloat()
        }
        root.addView(behindPill, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.TOP).apply { topMargin = dp(24); leftMargin = dp(24) })

        // Who's here: their circles and how many are watching, top right, with the controls.
        whoPill = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(16), dp(6))
            background = GradientDrawable().apply { cornerRadius = dp(99).toFloat(); setColor(0xB30D0B0A.toInt()) }
            visibility = View.GONE
        }
        root.addView(whoPill, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.TOP).apply { topMargin = dp(28); rightMargin = dp(36) })
    }

    private fun renderWho() {
        val people = info.optJSONArray("people") ?: JSONArray()
        whoPill.removeAllViews()
        if (people.length() < 2 || !barVisible) { whoPill.visibility = View.GONE; return }
        for (k in 0 until minOf(4, people.length())) {
            val name = people.optJSONObject(k)?.optString("name").orEmpty().ifEmpty { "?" }
            whoPill.addView(avatarView(name, 32).apply { if (k > 0) (layoutParams as LinearLayout.LayoutParams).leftMargin = -dp(8) })
        }
        whoPill.addView(text(15f, Color.WHITE, bold = true).apply {
            text = "${people.length()} watching" + if (info.optBoolean("detached")) " · not synced" else " · in sync"
            setPadding(dp(12), 0, 0, 0)
        })
        whoPill.visibility = View.VISIBLE
    }


    /** A guest who has fallen well behind the room gets a one-press way back, even with the bar hidden. */
    private fun updateBehindPill() {
        val behind = info.optInt("behind")
        val host = info.optString("hostName").ifEmpty { "the host" }
        // Anyone in a party who has fallen behind the room (a co-host too), except the main host, who sets the pace.
        val want = info.optBoolean("hostOnly") && !info.optBoolean("isMain") &&
            (if (behindShown) behind >= 3 else behind >= 8)
        if (want) {
            behindPill.text = "You're ${if (behind < 60) "$behind s" else clock(behind * 1000L)} behind $host  ·  Press OK to catch up"
            if (!behindShown) { behindShown = true; behindPill.alpha = 0f; behindPill.visibility = View.VISIBLE; behindPill.animate().alpha(1f).setDuration(180).start() }
        } else if (behindShown) {
            behindShown = false
            behindPill.visibility = View.GONE
        }
    }

    // ---------- chat ----------
    /** "Sam is typing…" while someone does; gone when they stop, send, or go quiet for a few seconds. */
    fun onTyping(who: String, on: Boolean) {
        val name = who.ifEmpty { "Someone" }
        typingNow.remove(name)?.let { handler.removeCallbacks(it) }
        if (on) {
            val gone = Runnable { typingNow.remove(name); renderTyping() }
            typingNow[name] = gone
            handler.postDelayed(gone, 6000)
        }
        renderTyping()
    }

    private fun renderTyping() {
        typingView?.let { chatStack.removeView(it) }
        typingView = null
        if (typingNow.isEmpty() || !chatOn) return
        (chatStack.layoutParams as FrameLayout.LayoutParams).gravity = (if (panelVisible) Gravity.START else Gravity.END) or Gravity.TOP
        chatStack.requestLayout()
        val names = typingNow.keys.toList()
        val label = if (names.size == 1) "${names[0]} is typing…" else "${names.take(2).joinToString(" and ")} are typing…"
        val v = TextView(activity).apply {
            text = label
            textSize = 14f
            setTextColor(MUTED)
            setPadding(dp(14), dp(7), dp(14), dp(7))
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(0x99000000.toInt()) }
        }
        chatStack.addView(v, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        typingView = v
    }

    /** Tell the others we're typing (once, then again every few seconds), and when we stop. */
    private var lastTypingPing = 0L
    private fun myTyping(now: Boolean) {
        if (now) {
            val t = android.os.SystemClock.uptimeMillis()
            if (!iAmTyping || t - lastTypingPing > 3000) { iAmTyping = true; lastTypingPing = t; activity.emitTyping(true) }
        } else if (iAmTyping) { iAmTyping = false; activity.emitTyping(false) }
    }
    fun onPin(on: Boolean, name: String, text: String, img: Boolean, by: String) {
        pinned = if (on) Triple(name.ifEmpty { "Someone" }, if (img) "a photo" else text, by.ifEmpty { "Someone" }) else null
        if (on) presence("📌 ${by.ifEmpty { "Someone" }} pinned a message")
        if (panelKind == "chat") renderPanel()
    }
    fun onChat(who: String, text: String, self: Boolean, rName: String = "", rText: String = "") {
        if (isReaction(text)) { if (!self) floatReaction(text.trim(), who.ifEmpty { "Someone" }); return }
        chatLog.addLast(ChatLine(if (self) "You" else who.ifEmpty { "Someone" }, text, rName, rText))
        while (chatLog.size > 30) chatLog.removeFirst()
        if (panelKind == "chat") {
            // The conversation is open: add the line without taking the keyboard away from someone typing.
            val typing = chatInput?.hasFocus() == true
            renderPanel()
            if (typing) chatInput?.requestFocus() else focusPanel()
            return
        }
        if (!self) { chatUnread++; chatChip.badge("$chatUnread") }
        if (self || !chatOn) return
        // Beside an open panel (invite, who's here…) the pop-up goes to the left, so it's never hidden behind it.
        (chatStack.layoutParams as FrameLayout.LayoutParams).gravity = (if (panelVisible) Gravity.START else Gravity.END) or Gravity.TOP
        chatStack.requestLayout()
        val bubble = TextView(activity).apply {
            val name = who.ifEmpty { "Someone" }
            val s = android.text.SpannableString("$name  $text")
            s.setSpan(android.text.style.ForegroundColorSpan(ACCENT), 0, name.length, 0)
            s.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, name.length, 0)
            setText(s)
            textSize = 15f
            setTextColor(Color.WHITE)
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(14), dp(9), dp(14), dp(9))
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(0x8C000000.toInt()) }
            alpha = 0f
        }
        chatStack.addView(bubble, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        while (chatStack.childCount > 4) chatStack.removeViewAt(0)
        bubble.animate().alpha(1f).setDuration(200).start()
        handler.postDelayed({ bubble.animate().alpha(0f).setDuration(500).withEndAction { chatStack.removeView(bubble) }.start() }, 7000)
    }

    private fun scrollChatToEnd() { panelScroll.post { panelScroll.fullScroll(View.FOCUS_DOWN); chatInput?.requestFocus() } }

    /** A QR code and the typed address of this room, so a phone or computer can join it (chat now; calls and video come from reddate.xyz). */
    private fun phoneJoinCard(headline: String, sub: String): View? {
        // The room's invite link points at the party page; the Lounge (chat, voice and video only) is the same room at /lounge/.
        val link = info.optString("invite").replace("/join/", "/lounge/")
        if (link.isEmpty()) return null
        val bmp = try {
            val m = com.google.zxing.qrcode.QRCodeWriter().encode(link, com.google.zxing.BarcodeFormat.QR_CODE, 360, 360, mapOf(com.google.zxing.EncodeHintType.MARGIN to 0))
            val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) Color.BLACK else Color.WHITE }
            android.graphics.Bitmap.createBitmap(px, m.width, m.height, android.graphics.Bitmap.Config.ARGB_8888)
        } catch (_: Exception) { null }
        return LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(0xFF1A1614.toInt()) }
            if (bmp != null) addView(ImageView(activity).apply {
                setImageBitmap(bmp)
                setPadding(dp(6), dp(6), dp(6), dp(6))
                background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(Color.WHITE) }
                layoutParams = LinearLayout.LayoutParams(dp(92), dp(92)).apply { rightMargin = dp(14) }
            })
            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                addView(text(16f, Color.WHITE, bold = true).apply { text = headline })
                addView(text(13f, MUTED).apply { text = sub; setPadding(0, dp(3), 0, dp(6)) })
                addView(text(13f, Color.WHITE, bold = true).apply { text = link.removePrefix("https://").removePrefix("http://"); maxLines = 2; ellipsize = TextUtils.TruncateAt.MIDDLE })
            })
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10); bottomMargin = dp(8) }
        }
    }

    /** The Lounge link as a big QR code: chat, voice and video from a phone or computer (the TV has no microphone or camera). */
    private fun renderPhoneChat() {
        panelTitle.text = "Join the Lounge"
        // Watching alone has no room on the server yet; opening the Lounge makes it a real one so the link works.
        uiScope.launch { try { Engine.call("goLive") } catch (_: Exception) {} }
        add(note("Open it on a phone or computer to chat, talk and see each other. This TV stays in the chat."))
        phoneJoinCard("Scan to join", "The same room: chat, voice and video")?.let { add(it) }
    }

    // ---------- quick replies the viewer can edit ----------
    private var quickEdit = false
    private val quickToggleId = View.generateViewId()
    private val quickDefaults = listOf("Pause!", "Next one?", "Snack break", "😂", "🔥", "😱", "👍", "❤️")
    private fun quickList(): List<String> {
        val parts = activity.quickReplies.split('\u0001')
        return if (parts.size == quickDefaults.size) parts else quickDefaults
    }
    private fun saveQuick(i: Int, value: String) {
        val cur = quickList().toMutableList()
        cur[i] = value.trim()
        activity.quickReplies = cur.joinToString("\u0001")
    }

    /** The quick replies and emoji: hidden behind the Reactions chip so the conversation keeps the room. */
    private fun addQuickReplies() {
        // Quick replies: one press sends them, so nobody has to type with the remote. An emoji floats up for everyone.
        // The pencil makes them editable: phrases and emoji are the viewer's own, kept on this TV.
        add(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(text(13f, MUTED).apply { this.text = "Quick replies"; setPadding(dp(4), 0, dp(12), 0) })
            addView(chip(if (quickEdit) "Done" else "✎ Edit") {
                quickEdit = !quickEdit
                renderPanel(); focusPanel()
            }.apply { id = quickToggleId; textSize = 13f; setPadding(dp(12), dp(4), dp(12), dp(4)) })
            if (quickEdit) addView(chip("Reset") {
                activity.quickReplies = ""
                renderPanel(); focusPanel()
            }.apply { textSize = 13f; setPadding(dp(12), dp(4), dp(12), dp(4)) })
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10); bottomMargin = dp(8) }
        })
        val quick = quickList()
        for ((rowNo, range) in listOf(0 until 3, 3 until 8).withIndex()) {
            add(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                for (i in range) {
                    val q = quick[i]
                    if (quickEdit) {
                        addView(EditText(activity).apply {
                            setText(q); setSingleLine(true); textSize = if (rowNo == 1) 20f else 15f
                            setTextColor(Color.WHITE); gravity = Gravity.CENTER
                            filters = arrayOf(android.text.InputFilter.LengthFilter(if (rowNo == 1) 8 else 24))
                            background = focusBackground(radius = 14, idle = 0x33FFFFFF, focused = 0x66FFFFFF)
                            setPadding(dp(10), dp(8), dp(10), dp(8))
                            imeOptions = EditorInfo.IME_ACTION_DONE
                            if (rowNo == 0) nextFocusUpId = quickToggleId
                            addTextChangedListener(object : android.text.TextWatcher {
                                override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
                                override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
                                override fun afterTextChanged(e: android.text.Editable?) { saveQuick(i, e?.toString().orEmpty()) }
                            })
                            layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = dp(8) }
                        })
                    } else if (q.isNotBlank()) {
                        addView(chip(q) {
                            if (isReaction(q)) { burstReaction(q, "You"); activity.emitBurst(q) } else activity.emitChat(q)
                            armPanelIdle()
                        }.apply { textSize = if (isReaction(q)) 20f else 15f; setPadding(dp(14), dp(8), dp(14), dp(8)); (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(8) })
                    }
                }
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }
            })
        }
    }

    private var reactOpen = false
    private fun renderChat() {
        panelTitle.text = "Party chat"
        // Oldest at the top, newest just above the reply box (like any messaging app). Each line can take
        // focus, so Up walks back through the conversation.
        val lines = chatLog.toList().takeLast(40)
        if (lines.isEmpty()) add(note("No messages yet. Say hi!"))
        pinned?.let { (pn, pt, _) ->
            add(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                isFocusable = true
                setPadding(dp(14), dp(10), dp(14), dp(10))
                background = focusBackground(radius = 14, idle = 0xFF2A1D17.toInt(), focused = 0xFF3A2A22.toInt())
                addView(TextView(activity).apply { text = "📌 Pinned · $pn"; textSize = 13f; setTypeface(typeface, Typeface.BOLD); setTextColor(0xFFFFB08F.toInt()) })
                addView(TextView(activity).apply { text = pt; textSize = 16f; setTextColor(Color.WHITE); maxLines = 3; ellipsize = TextUtils.TruncateAt.END })
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) }
            })
        }
        for (line in lines) {
            val who = line.who; val text = line.text
            val mine = who == "You"
            // A message: the sender's circle and a bubble. Each person keeps one colour; yours are orange, on the right.
            add(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = if (mine) Gravity.END else Gravity.START
                isFocusable = true
                setPadding(dp(4), dp(4), dp(4), dp(4))
                background = focusBackground(radius = 18, idle = Color.TRANSPARENT, focused = 0x26FFFFFF)
                if (!mine) addView(avatarView(who, 34).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(10) })
                addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(14), dp(10), dp(14), dp(11))
                    background = GradientDrawable().apply {
                        val r = dp(18).toFloat(); val k = dp(6).toFloat()
                        cornerRadii = if (mine) floatArrayOf(r, r, r, r, k, k, r, r) else floatArrayOf(r, r, r, r, r, r, k, k)
                        setColor(if (mine) ACCENT else 0xFF25201D.toInt())
                    }
                    if (!mine) addView(TextView(activity).apply { this.text = who; textSize = 13f; setTypeface(typeface, Typeface.BOLD); setTextColor(palette(who)) })
                    if (line.rName.isNotEmpty()) addView(TextView(activity).apply {
                        this.text = "${line.rName}  ${line.rText}"; textSize = 13f; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                        setTextColor(if (mine) 0xCC160C07.toInt() else 0xFFBFB3A6.toInt())
                        setPadding(dp(10), dp(3), dp(10), dp(3))
                        background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(if (mine) 0x22000000 else 0x22FFFFFF) }
                        (layoutParams as? LinearLayout.LayoutParams)?.bottomMargin = dp(6)
                    }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(6) })
                    addView(TextView(activity).apply { this.text = text; textSize = 18f; setTextColor(if (mine) 0xFF160C07.toInt() else Color.WHITE); if (mine) setTypeface(typeface, Typeface.BOLD); setLineSpacing(0f, 1.1f) })
                }, LinearLayout.LayoutParams(-2, -2).apply { if (mine) leftMargin = dp(40) else rightMargin = dp(24) })
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) }
            })
        }
        val input = EditText(activity).apply {
            hint = "Type a reply"
            setHintTextColor(MUTED)
            setTextColor(Color.WHITE)
            textSize = 18f
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEND
            background = focusBackground(radius = 12, idle = 0x33FFFFFF, focused = 0x55FFFFFF)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setOnEditorActionListener { v, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE) {
                    val t = v.text.toString().trim()
                    if (t.isNotEmpty()) { activity.emitChat(t); v.text = ""; chatDraft = ""; myTyping(false) }
                    true
                } else false
            }
            setOnClickListener { (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, 0) }
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10); topMargin = dp(8) }
            setText(chatDraft); setSelection(text.length)
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) { chatDraft = e?.toString().orEmpty(); myTyping(chatDraft.isNotEmpty()) }
                override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            })
        }
        chatInput = input
        add(input)
        // Reactions, the phone Lounge and pop-ups sit in one small row under the reply box, so messages get the space.
        add(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(chip(if (reactOpen) "😊 Reactions ▴" else "😊 Reactions") { reactOpen = !reactOpen; if (!reactOpen) quickEdit = false; renderPanel(); focusSame("react") }.apply { tag = "react"; textSize = 14f })
            if (info.optString("invite").isNotEmpty()) addView(chip("📞 🎥 Lounge") { openPanel("phonechat") }.apply { tag = "phonechat"; textSize = 14f })
            addView(chip(if (chatOn) "Pop-ups: On" else "Pop-ups: Off") {
                chatOn = !chatOn
                if (!chatOn) chatStack.removeAllViews()
                activity.emitChatPref(chatOn)
                renderPanel(); focusSame("chatpref")
            }.apply { tag = "chatpref"; textSize = 14f })
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }
        })
        if (reactOpen) addQuickReplies()
        scrollChatToEnd()
    }

    // ---------- small view helpers ----------
    private fun text(size: Float, color: Int, bold: Boolean = false) = TextView(activity).apply {
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun focusBackground(radius: Int, idle: Int, focused: Int) = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_focused), GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(focused) })
        addState(intArrayOf(), GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(idle) })
    }

    private fun focusText() = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(INK, Color.WHITE))

    private fun chip(label: String, onClick: () -> Unit) = TextView(activity).apply {
        text = label
        textSize = 15f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(focusText())
        background = focusBackground(radius = 999, idle = 0x2EFFFFFF, focused = Color.WHITE)
        setPadding(dp(16), dp(8), dp(16), dp(8))
        isFocusable = true
        isClickable = true
        setOnClickListener { onClick() }
        // The chip you're on lifts a little and settles; transform only, so it costs nothing to draw.
        setOnFocusChangeListener { v, has -> v.animate().scaleX(if (has) 1.08f else 1f).scaleY(if (has) 1.08f else 1f).setDuration(if (has) 180 else 120).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start() }
        layoutParams = LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12) }
    }

    /** A chip's small count or note ("2" unread, "30m" left); the icon alone when there is none. */
    private fun TextView.badge(t: String) { text = t; compoundDrawablePadding = if (t.isEmpty()) 0 else dp(6) }

    /** A button that is just an icon (with a small count when it has one): white when focused, lifts a little. */
    private fun iconChip(res: Int, desc: String, onClick: () -> Unit) = TextView(activity).apply {
        contentDescription = desc
        text = ""
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(focusText())
        activity.resources.getDrawable(res, activity.theme)?.let { d ->
            d.setBounds(0, 0, dp(22), dp(22))
            setCompoundDrawables(d, null, null, null)
            compoundDrawableTintList = focusText()
        }
        gravity = Gravity.CENTER
        setPadding(dp(13), 0, dp(13), 0)
        background = focusBackground(radius = 999, idle = 0x2EFFFFFF, focused = Color.WHITE)
        isFocusable = true
        isClickable = true
        setOnClickListener { onClick() }
        setOnFocusChangeListener { v, has -> v.animate().scaleX(if (has) 1.1f else 1f).scaleY(if (has) 1.1f else 1f).setDuration(if (has) 180 else 120).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start() }
        layoutParams = LinearLayout.LayoutParams(-2, dp(48)).apply { rightMargin = dp(10) }
    }

    /** A round control (back, play/pause, forward): white when focused, lifts a little. */
    private fun roundChip(label: String, sizeDp: Int, onClick: () -> Unit) = TextView(activity).apply {
        text = label
        textSize = if (sizeDp >= 50) 19f else 13f
        gravity = Gravity.CENTER
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(focusText())
        background = focusBackground(radius = 999, idle = 0x2EFFFFFF, focused = Color.WHITE)
        isFocusable = true
        isClickable = true
        setOnClickListener { onClick() }
        setOnFocusChangeListener { v, has -> v.animate().scaleX(if (has) 1.1f else 1f).scaleY(if (has) 1.1f else 1f).setDuration(if (has) 180 else 120).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start() }
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)).apply { rightMargin = dp(10) }
    }

    /** One row in a side panel: a label, an optional second line, and a check when selected. */
    private fun row(label: String, sub: String? = null, checked: Boolean = false, onClick: (() -> Unit)? = null): View {
        val l = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = focusBackground(radius = 10, idle = Color.TRANSPARENT, focused = Color.WHITE)
            isFocusable = onClick != null
            isClickable = onClick != null
            if (onClick != null) setOnClickListener { onClick() }
        }
        val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; isDuplicateParentStateEnabled = true }
        texts.addView(text(17f, Color.WHITE).apply { text = label; setTextColor(focusText()); isDuplicateParentStateEnabled = true; maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
        if (!sub.isNullOrEmpty()) texts.addView(text(13f, MUTED).apply {
            text = sub
            setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xCC101010.toInt(), MUTED)))
            isDuplicateParentStateEnabled = true
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        })
        l.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
        l.addView(text(18f, ACCENT, bold = true).apply { text = if (checked) "✓" else ""; isDuplicateParentStateEnabled = true })
        l.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4) }
        return l
    }

    private fun note(msg: String) = text(15f, MUTED).apply { text = msg; setPadding(dp(14), dp(8), dp(14), dp(8)) }

    // ---------- bar ----------
    val barVisible get() = bar.visibility == View.VISIBLE
    // Open as soon as it's asked for and closed as soon as it's dismissed (not when the slide animation ends).
    val panelVisible get() = panelKind.isNotEmpty()

    fun showBar(focus: View? = null) {
        if (!barVisible) {
            bar.visibility = View.VISIBLE
            bar.alpha = 0f
            bar.animate().alpha(1f).setDuration(180).start()
            bar.post { liftSubtitles(bar.height) }
            handler.removeCallbacks(progressRunnable)
            handler.post(progressRunnable)
        }
        updateMeta()
        updatePlayChip()
        val target = focus ?: (bar.findFocus() ?: playChip)
        target.requestFocus()
        scheduleHide()
    }

    fun hideBar() {
        if (panelVisible) return
        handler.removeCallbacks(hideRunnable)
        handler.removeCallbacks(progressRunnable)
        bar.animate().alpha(0f).setDuration(180).withEndAction { bar.visibility = View.GONE }.start()
        whoPill.visibility = View.GONE
        liftSubtitles(0)
        root.requestFocus()
    }

    private fun scheduleHide() {
        handler.removeCallbacks(hideRunnable)
        if (!panelVisible) handler.postDelayed(hideRunnable, HIDE_AFTER_MS)
    }

    private fun toastBar(msg: String) { meta.text = msg; handler.postDelayed({ updateMeta() }, 3000) }

    fun updatePlayChip() { playChip.text = if (playerOf()?.playWhenReady == true) "❚❚" else "▶" }

    private fun updateMeta() {
        val n = info.optJSONArray("people")?.length() ?: 0
        val code = info.optString("room")
        val behind = info.optInt("behind")
        meta.text = listOfNotNull(
            if (info.optBoolean("detached")) "Not synced" + (if (behind > 0) " · ${clock(behind * 1000L)} behind" else "") else null,
            // A guest sits on the first frame (often black) until the host presses play: say so.
            if (playerOf()?.playerError != null) "This stream didn't play · Press Back and pick another" else null,
            // Only while the host hasn't started either: if they're ahead, this is a load problem, not a wait.
            if (isGuest && playerOf()?.playerError == null && behind < 5 && playerOf()?.playWhenReady == false && (playerOf()?.currentPosition ?: 0L) < 3000L) "Waiting for ${info.optString("hostName").ifEmpty { "the host" }} to press play" else null,
            if (n > 0) (if (n == 1) "Just you" else "$n watching") else null,
            endsAt(),
            // Playing alone shows no code. It appears once you open Invite, or someone else is here.
            if (code.isNotEmpty() && (inviteShown || n > 1)) "Room $code" else null
        ).joinToString("  ·  ")
        meta.setTextColor(if (info.optBoolean("detached")) ACCENT else MUTED)
        updateBehindPill()
        renderWho()
        // Sync only means something when someone else is here.
        syncChip.visibility = if (n > 1) View.VISIBLE else View.GONE
        syncChip.contentDescription = if (isGuest) "Sync to ${info.optString("hostName").ifEmpty { "the host" }}" else "Sync everyone to my spot"
    }

    /** "Ends 23:29": when the video will finish if it plays on from here. */
    private fun endsAt(): String? {
        val p = playerOf() ?: return null
        val left = p.duration - p.currentPosition
        if (p.duration <= 0 || left <= 0 || p.isCurrentMediaItemLive) return null
        val fmt = java.text.SimpleDateFormat("HH:mm", Locale.getDefault())
        return "Ends " + fmt.format(java.util.Date(System.currentTimeMillis() + (left / p.playbackParameters.speed).toLong()))
    }

    private fun updateProgress() {
        val p = playerOf() ?: return
        val dur = p.duration
        val pos = if (scrubTo >= 0) scrubTo else p.currentPosition
        scrubThumbs?.let { it.playheadMs = pos; it.hold = p.playbackState == androidx.media3.common.Player.STATE_BUFFERING }
        progress.progress = if (dur > 0) (pos * 1000 / dur).toInt() else 0
        progress.secondaryProgress = if (dur > 0) (p.bufferedPosition * 1000 / dur).toInt() else 0
        time.text = when {
            p.isCurrentMediaItemLive || (dur <= 0 && p.playbackState == androidx.media3.common.Player.STATE_READY) -> "● LIVE"
            dur > 0 -> "${clock(pos)} / ${clock(dur)}"
            else -> clock(pos)
        }
    }

    private fun clock(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return if (s >= 3600) String.format(Locale.US, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
        else String.format(Locale.US, "%d:%02d", s / 60, s % 60)
    }

    private val isGuest get() = info.optBoolean("hostOnly") && !info.optBoolean("isHost", true)

    /** Sync: the host pulls everyone to their spot; a guest catches up with the host. */
    private fun onSyncPressed() {
        activity.emitAction("sync")
        toastBar(if (!isGuest) "Everyone is jumping to your spot" else if (info.optBoolean("detached")) "Syncing with ${info.optString("hostName").ifEmpty { "the host" }}…" else "You're in sync")
    }

    private fun togglePlay() {
        val p = playerOf() ?: return
        if (p.playWhenReady) p.pause() else p.play()
        updatePlayChip()
        scheduleHide()
    }

    // Scrubbing: the presses move a cursor (with its preview picture); the video only jumps once you stop,
    // so a long move is one seek instead of dozens, and holding the button speeds up.
    private var scrubTo = -1L
    private var lastSkipAt = 0L
    private var lastSkipDir = 0
    private var streak = 0
    private val commitSeek = Runnable { commitScrub() }

    /** True while the viewer is sliding (and for a moment after): the room must not move the player then. */
    fun scrubbing(): Boolean = scrubTo >= 0 || android.os.SystemClock.uptimeMillis() - lastSkipAt < 2500

    private fun commitScrub() {
        handler.removeCallbacks(commitSeek)
        val to = scrubTo
        if (to < 0) return
        scrubTo = -1
        lastSkipAt = android.os.SystemClock.uptimeMillis()
        activity.userSeek(to)
        updateProgress()
    }

    /** How far one press goes: 10 s, then 30 s, 1 min and 2 min the longer you hold (or the faster you tap). */
    private fun stepFor(e: KeyEvent?, dir: Int): Long {
        val now = android.os.SystemClock.uptimeMillis()
        streak = if (dir == lastSkipDir && now - lastSkipAt < 450) streak + 1 else 0
        lastSkipAt = now; lastSkipDir = dir
        val n = maxOf(streak, e?.repeatCount ?: 0)
        return when { n < 4 -> 10_000L; n < 12 -> 30_000L; n < 24 -> 60_000L; else -> 120_000L }
    }

    private fun skip(ms: Long) {
        val p = playerOf() ?: return
        // Some files can't jump (no index to seek with, or a host that only sends from the start): asking them to
        // jump starts them over from 0:00. Say so instead of throwing the viewer back to the beginning.
        if (!p.isCurrentMediaItemSeekable) { showToast("This stream can’t skip ahead. Pick another stream to jump around."); return }
        val dur = p.duration
        var to = ((if (scrubTo >= 0) scrubTo else p.currentPosition) + ms).coerceAtLeast(0)
        if (dur > 0) to = to.coerceAtMost(dur - 1000)
        scrubTo = to
        handler.removeCallbacks(commitSeek)
        handler.postDelayed(commitSeek, 750)
        updateProgress()
        showPreview(to, dur)
    }

    // ---------- leaving: one clear question, then the room is gone (so Home has no "Now playing" to tidy up) ----------
    private fun askToLeave() {
        val people = info.optJSONArray("people")?.length() ?: 0
        val others = (people - 1).coerceAtLeast(0)
        val guest = isGuest
        val body = when {
            guest -> "The party carries on without you."
            others > 0 -> "Leaving ends the party for everyone ($others other ${if (others == 1) "person" else "people"})."
            (playerOf()?.currentPosition ?: 0L) > 30_000L -> "Your place is saved in Continue watching."
            else -> ""
        }
        val what = activity.titleText.ifEmpty { "this video" }
        activity.invitePrompt.askBig(
            if (guest) "WATCH PARTY" else what.uppercase().take(40),
            if (guest) "Leave the party?" else "Stop watching?",
            body, activity.artUrl,
            if (guest) "Leave the party" else if (others > 0) "End party and leave" else "Stop and leave", "Keep watching"
        ) { yes -> if (yes) activity.leaveAndClose() }
    }

    // ---------- autoplay next episode (done here, on the TV, so it doesn't depend on the page being awake) ----------
    private var nextCancelled = false

    private fun nextEpisode(): JSONObject? {
        val eps = info.optJSONArray("episodes") ?: return null
        val cur = info.optString("current")
        val list = (0 until eps.length()).mapNotNull { eps.optJSONObject(it) }
        val i = list.indexOfFirst { it.optString("id") == cur }
        return if (i >= 0) list.getOrNull(i + 1) else null
    }

    /** Autoplay is on, the show has a next episode, and this viewer drives (a party guest follows the host). */
    fun willAutoPlayNext(): Boolean =
        info.optBoolean("autoNext", true) && nextEpisode() != null && !(info.optBoolean("hostOnly") && !info.optBoolean("isHost", true))

    fun autoPlayNext() {
        val nx = nextEpisode() ?: return
        nextCancelled = false
        val label = "S${nx.optInt("season")}E${nx.optInt("episode")}" + nx.optString("title").let { if (it.isEmpty()) "" else " · $it" }
        if (!barVisible) showBar()
        toastBar("Up next: $label")
        handler.postDelayed({
            if (!nextCancelled) activity.emitEpisode(nx.optString("id"), label)
        }, 4000)
    }

    // ---------- scrub preview (a picture of where you're going, like Netflix) ----------
    private var scrubThumbs: Thumbnailer? = null
    private var thumbsFor = ""
    private val previewImage = android.widget.ImageView(activity).apply { scaleType = android.widget.ImageView.ScaleType.CENTER_CROP }
    private val previewTime = text(15f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0) }
    private val previewCard = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(5), dp(5), dp(5), dp(6))
        background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(0xF00D0B0A.toInt()); setStroke(dp(2), Color.WHITE) }
        addView(previewImage, LinearLayout.LayoutParams(dp(224), dp(126)))
        addView(previewTime, LinearLayout.LayoutParams(-1, -2))
        visibility = View.GONE
        elevation = dp(8).toFloat()
    }
    private val hidePreview = Runnable { previewCard.animate().alpha(0f).setDuration(160).withEndAction { previewCard.visibility = View.GONE }.start() }
    private var previewMs = 0L

    private fun thumbnailer(): Thumbnailer? {
        val u = activity.url
        if (!u.startsWith("http")) return null
        if (thumbsFor != u) { scrubThumbs?.close(); scrubThumbs = Thumbnailer(u); thumbsFor = u }
        return scrubThumbs
    }

    /** Open the stream for previews in the background the moment playback is ready, and fill the whole timeline, so scrubbing never waits. */
    fun warmPreviews() {
        handler.postDelayed({
            val p = playerOf() ?: return@postDelayed
            val t = thumbnailer() ?: return@postDelayed
            val now = p.currentPosition
            t.request(now, false) { }
            for (d in listOf(10_000L, 30_000L, 60_000L, -10_000L)) t.request((now + d).coerceAtLeast(0), false) { }
            t.startFill(p.duration) // then a picture every minute, then every 30 s, across the whole video
        }, 300)
    }

    private fun showPreview(ms: Long, dur: Long) {
        val t = thumbnailer()
        previewMs = ms
        val img = t?.peek(ms)
        previewTime.text = if (img == null && t != null && !t.failed) clock(ms) + "  ·  loading preview…" else clock(ms)
        if (img != null) previewImage.setImageBitmap(img) else previewImage.setImageDrawable(null)
        previewImage.setBackgroundColor(0xFF25201D.toInt())
        if (previewCard.parent == null) root.addView(previewCard, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START))
        bar.post { positionPreview(ms, dur) }
        previewCard.removeCallbacks(hidePreview)
        previewCard.animate().cancel()
        previewCard.alpha = 1f
        previewCard.visibility = View.VISIBLE
        previewCard.postDelayed(hidePreview, 2500)
        // The picture itself, then the ones just ahead and behind, so the next presses are instant.
        t?.request(ms, true) { at -> if (at == (ms / Thumbnailer.STEP_MS) * Thumbnailer.STEP_MS) previewCard.post { if (previewMs == ms) t.peek(ms)?.let { previewImage.setImageBitmap(it) } } }
        for (d in listOf(10_000L, -10_000L, 20_000L, -20_000L, 30_000L)) {
            val n = (ms + d).coerceAtLeast(0)
            if (dur <= 0 || n < dur) t?.request(n, false) { }
        }
    }

    private fun positionPreview(ms: Long, dur: Long) {
        val loc = IntArray(2); progress.getLocationInWindow(loc)
        val rloc = IntArray(2); root.getLocationInWindow(rloc)
        val frac = if (dur > 0) (ms.toFloat() / dur).coerceIn(0f, 1f) else 0f
        val cardW = dp(224) + dp(10)
        val x = (loc[0] - rloc[0] + progress.width * frac - cardW / 2f).coerceIn(dp(24).toFloat(), (root.width - cardW - dp(24)).toFloat())
        val lp = previewCard.layoutParams as FrameLayout.LayoutParams
        lp.leftMargin = x.toInt()
        lp.bottomMargin = (rloc[1] + root.height) - loc[1] + dp(10)
        previewCard.layoutParams = lp
    }

    /** Remote keys. Returns true when handled here. */
    fun onKey(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return false
        if (wakeOrKeep()) return true
        val code = e.keyCode
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) nextCancelled = true // the viewer is doing something: no auto-start
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            val p = playerOf() ?: return true
            when (code) {
                KeyEvent.KEYCODE_MEDIA_PLAY -> p.play()
                KeyEvent.KEYCODE_MEDIA_PAUSE -> p.pause()
                else -> togglePlay()
            }
            showBar()
            return true
        }
        if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) { skip(stepFor(e, 1)); showBar(seekRow); return true }
        if (code == KeyEvent.KEYCODE_MEDIA_REWIND) { skip(-stepFor(e, -1)); showBar(seekRow); return true }
        if (code == KeyEvent.KEYCODE_BACK) {
            // In the subtitle settings, Back returns to the languages first.
            if (panelVisible && panelKind == "subs" && panel.findFocus()?.let { isInside(it, sideScroll) } == true) { focusPanel(); return true }
            if (panelVisible && panelKind == "substyle") { openPanel("subs"); return true } // back to the languages
            if (panelVisible && panelKind in setOf("episodes", "suggest", "search")) { openPanel("browse"); return true }
            if (panelVisible && panelKind == "phonechat") { openPanel("chat"); return true }
            if (panelVisible) { closePanel(); return true }
            // First Back shows the controls (Sync, Subtitles, Episodes…); Back again asks before leaving.
            if (!barVisible) { showBar(); return true }
            askToLeave()
            return true
        }
        if (panelVisible) {
            handler.removeCallbacks(hideRunnable)
            armPanelIdle()
            if ((panelKind == "substyle" || panelKind == "subs") && (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)) {
                val tag = panel.findFocus()?.tag as? String
                if (panelKind == "substyle" || (tag != null && tag.startsWith("adj:"))) return adjustFocused(if (code == KeyEvent.KEYCODE_DPAD_LEFT) -1 else 1)
                // In the languages: Right goes across to the settings.
                if (code == KeyEvent.KEYCODE_DPAD_RIGHT && isInside(panel.findFocus() ?: panel, panelScroll)) { focusSide(); return true }
            }
            // The remote never wanders off the panel: a move that would land outside it is swallowed.
            val dir = when (code) {
                KeyEvent.KEYCODE_DPAD_UP -> View.FOCUS_UP
                KeyEvent.KEYCODE_DPAD_DOWN -> View.FOCUS_DOWN
                KeyEvent.KEYCODE_DPAD_LEFT -> View.FOCUS_LEFT
                KeyEvent.KEYCODE_DPAD_RIGHT -> View.FOCUS_RIGHT
                else -> 0
            }
            if (dir != 0) {
                val f = panel.findFocus()
                val next = f?.focusSearch(dir)
                if (f != null && (next == null || !isInside(next, panel))) return true
            }
            return false
        }
        if (!barVisible) {
            if (behindShown && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)) {
                // A guest asks to be synced; a co-host just catches themselves up (their Sync would move everyone).
                if (isGuest) onSyncPressed() else { activity.emitSyncAnswer(true); toastBar("Catching up…") }
                return true
            }
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> { skip(-stepFor(e, -1)); showBar(seekRow); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { skip(stepFor(e, 1)); showBar(seekRow); return true }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_MENU -> { showBar(); return true }
            }
            return false
        }
        scheduleHide()
        // The controls are up but nothing in them has focus (they faded in on their own): the first press lands on
        // play/pause instead of going wherever Android's focus search would send it (the progress bar, which skips).
        if (!bar.hasFocus() && code in intArrayOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER)) {
            playChip.requestFocus(); return true
        }
        if (seekRow.hasFocus() || seekRow.isFocused) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> { skip(-stepFor(e, -1)); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { skip(stepFor(e, 1)); return true }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> { if (scrubTo >= 0) commitScrub() else togglePlay(); return true }
                KeyEvent.KEYCODE_DPAD_DOWN -> { playChip.requestFocus(); return true }
                KeyEvent.KEYCODE_DPAD_UP -> return true
            }
        }
        // Left/Right walk the buttons in order (Android's own guess sometimes jumped up to the progress bar).
        if (chips.hasFocus() && (code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_LEFT)) {
            val kids = (0 until chips.childCount).map { chips.getChildAt(it) }.filter { it.visibility == View.VISIBLE && it.isFocusable }
            val i = kids.indexOfFirst { it.isFocused }
            val j = i + if (code == KeyEvent.KEYCODE_DPAD_RIGHT) 1 else -1
            if (i >= 0 && j in kids.indices) kids[j].requestFocus()
            return true
        }
        if (chips.hasFocus() && code == KeyEvent.KEYCODE_DPAD_UP) { seekRow.requestFocus(); return true }
        if (chips.hasFocus() && code == KeyEvent.KEYCODE_DPAD_DOWN) return true
        return false
    }

    // ---------- side panels ----------
    private var returnFocus: View? = null

    private fun isInside(v: View, parent: View): Boolean {
        var x: View? = v
        while (x != null) { if (x === parent) return true; x = x.parent as? View }
        return false
    }

    // A panel nobody touches for a while goes away by itself (the chat stays: people type slowly).
    private val panelIdle = Runnable { if (panelVisible && panelKind !in setOf("chat", "phonechat", "invite", "subs", "substyle", "search", "suggest", "browse")) closePanel() }
    private fun armPanelIdle() { handler.removeCallbacks(panelIdle); handler.postDelayed(panelIdle, 10_000) }

    private fun panelWidth(kind: String) = if (kind in setOf("subs", "substyle", "chat", "phonechat", "browse", "suggest", "search")) dp(440) else dp(340)

    fun openPanel(kind: String) {
        if (kind == "chat") { chatUnread = 0; chatChip.badge("") }
        if (kind == "invite") { inviteShown = true; updateMeta() }
        if (!panelVisible) returnFocus = bar.findFocus() // moving between panels keeps where Back should land
        panelKind = kind
        activity.previewSubtitles(false) // the style page has its own sample, pinned at the top
        // Subtitles is wide (languages on the left, settings on the right); the rest are a narrow column.
        val w = panelWidth(kind)
        if (panel.layoutParams.width != w) panel.layoutParams = (panel.layoutParams as FrameLayout.LayoutParams).apply { width = w }
        handler.removeCallbacks(hideRunnable)
        armPanelIdle()
        panel.animate().cancel()
        panelList.removeAllViews()
        if (panel.visibility != View.VISIBLE) {
            panel.visibility = View.VISIBLE
            panel.translationX = panelWidth(kind).toFloat()
        }
        panel.animate().translationX(0f).setDuration(200).withLayer().start()
        // The bar fades back so the panel isn't drawn over a row of buttons.
        bar.animate().alpha(0.25f).setDuration(160).withLayer().start()
        chips.isFocusable = false
        chips.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        seekRow.isFocusable = false
        // The rows are built on the next frame, so opening never stalls the picture.
        panel.post { if (panelKind == kind) { renderPanel(); focusPanel() } }
    }

    private fun focusPanel() {
        if (panelKind == "search" && searchInput != null) { searchInput?.requestFocus(); return }
        if (panelKind == "chat" && chatInput != null) { chatInput?.requestFocus(); scrollChatToEnd(); return }
        if (panelKind == "subs") { focusList(); return }
        for (i in 0 until panelList.childCount) {
            val c = panelList.getChildAt(i)
            if (c.isFocusable && (c.tag == "checked")) { c.requestFocus(); return }
        }
        for (i in 0 until panelList.childCount) { val c = panelList.getChildAt(i); if (c.isFocusable) { c.requestFocus(); return } }
        panel.requestFocus()
    }

    fun closePanel() {
        kickTarget = null
        panelKind = ""
        subsLang = ""
        subQuery = ""
        activity.previewSubtitles(false)
        handler.removeCallbacks(panelIdle)
        panel.animate().cancel()
        panel.animate().translationX(panel.width.toFloat().coerceAtLeast(dp(340).toFloat())).setDuration(180).withLayer().withEndAction { if (panelKind.isEmpty()) panel.visibility = View.GONE }.start()
        chips.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        seekRow.isFocusable = true
        bar.animate().alpha(1f).setDuration(160).withLayer().start()
        (returnFocus ?: playChip).requestFocus()
        scheduleHide()
    }

    private fun add(v: View, checked: Boolean = false) { if (checked) v.tag = "checked"; panelList.addView(v) }
    private fun addFixed(v: View) { panelFixed.addView(v) }
    private fun addSide(v: View) { panelSide.addView(v) }
    private fun focusSame(tag: String) { (panelList.findViewWithTag<View>(tag) ?: panelFixed.findViewWithTag<View>(tag) ?: panelSide.findViewWithTag<View>(tag))?.requestFocus() }

    private fun renderPanel() {
        panelList.removeAllViews()
        panelFixed.removeAllViews()
        panelSide.removeAllViews()
        sideScroll.visibility = View.GONE
        if (panelBg == null) panelBg = panel.background
        // Chat is for reading: a solid backdrop, not the see-through one the other panels use.
        panel.background = GradientDrawable().apply { setColor(0xF50D0B0A.toInt()) } // solid: panels are for reading, whatever the picture behind
        when (panelKind) {
            "subs" -> renderSubs()
            "audio" -> renderAudio()
            "invite" -> renderInvite()
            "people" -> renderPeople()
            "chat" -> renderChat()
            "episodes" -> renderEpisodes()
            "substyle" -> renderSubStyle()
            "browse" -> renderBrowse()
            "phonechat" -> renderPhoneChat()
            "suggest" -> renderSuggest()
            "search" -> renderSearch()
            "sleep" -> renderSleep()
        }
    }

    // ---------- reactions: an emoji sent from the chat panel floats up on everyone's screen ----------
    /** A message of nothing but one to three emoji is a reaction: it floats up instead of popping up as text. */
    private fun isReaction(t: String): Boolean {
        val s = t.trim()
        if (s.isEmpty() || s.length > 16 || s.any { it.isLetterOrDigit() }) return false
        return s.codePoints().toArray().count { Character.getType(it) == Character.OTHER_SYMBOL.toInt() || it > 0x1F000 } in 1..3
    }
    private fun floatReaction(e: String, who: String) {
        val v = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(activity).apply { text = e; textSize = 46f })
            addView(TextView(activity).apply {
                text = who; textSize = 14f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.WHITE)
                setPadding(dp(10), dp(4), dp(10), dp(4))
                background = GradientDrawable().apply { cornerRadius = dp(99).toFloat(); setColor(0x99000000.toInt()) }
            }, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(8) })
        }
        val lp = FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.BOTTOM).apply { rightMargin = dp(60 + (0..120).random()) + (if (panelVisible) panel.width else 0); bottomMargin = dp(150) }
        root.addView(v, lp)
        v.alpha = 0f; v.scaleX = 0.6f; v.scaleY = 0.6f
        // Rises and fades: transform and alpha only, on its own layer, so the video never stutters.
        v.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        v.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(-dp(80).toFloat()).setDuration(260).withEndAction {
            v.animate().translationY(-dp(360).toFloat()).alpha(0f).setDuration(2300).setInterpolator(android.view.animation.AccelerateInterpolator(1.2f)).withEndAction { root.removeView(v) }.start()
        }.start()
    }

    /** A reaction from the Lounge: the same emoji fills the whole screen, rising and fading (transform and alpha only, so the video never stutters). */
    private var burstsLive = 0
    fun burstReaction(e: String, who: String) {
        if (e.isBlank() || burstsLive > 70) return
        val w = root.width.takeIf { it > 0 } ?: return
        val h = root.height.takeIf { it > 0 } ?: return
        for (i in 0 until 22) handler.postDelayed({
            val size = (44..96).random()
            val v = TextView(activity).apply { text = e; textSize = size.toFloat(); includeFontPadding = false }
            val lp = FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.BOTTOM).apply { leftMargin = (0..(w - dp(size + 20)).coerceAtLeast(1)).random(); bottomMargin = -dp(20) }
            root.addView(v, lp)
            burstsLive++
            v.alpha = 0f; v.scaleX = 0.5f; v.scaleY = 0.5f
            v.setLayerType(View.LAYER_TYPE_HARDWARE, null)
            val rise = h * (0.55f + (0..40).random() / 100f)
            v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220).start()
            v.animate().translationY(-rise).setStartDelay(0).setDuration((2200..3400).random().toLong())
                .setInterpolator(android.view.animation.DecelerateInterpolator(0.8f))
                .withEndAction { root.removeView(v); burstsLive-- }.start()
            handler.postDelayed({ v.animate().alpha(0f).setDuration(900).start() }, 1700)
        }, i * 60L)
        if (who.isNotBlank()) {
            val tag = TextView(activity).apply {
                text = who; textSize = 16f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.WHITE)
                setPadding(dp(14), dp(6), dp(14), dp(6))
                background = GradientDrawable().apply { cornerRadius = dp(99).toFloat(); setColor(0x99000000.toInt()) }
            }
            root.addView(tag, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = dp(40) })
            tag.alpha = 0f
            tag.animate().alpha(1f).setDuration(200).withEndAction { tag.animate().alpha(0f).setStartDelay(1800).setDuration(500).withEndAction { root.removeView(tag) }.start() }.start()
        }
    }

    // ---------- sleep timer: the TV pauses and goes dark by itself ----------
    private var sleepAt = 0L              // when to sleep (0 = off)
    private var sleepAtEnd = false         // sleep when this episode or movie ends
    private var sleepWarned = false
    private var sleeping: View? = null
    private val sleepTick = object : Runnable {
        override fun run() {
            val p = playerOf()
            val now = System.currentTimeMillis()
            val target = if (sleepAtEnd && p != null && p.duration > 0) now + (p.duration - p.currentPosition) else sleepAt
            if (target <= 0L) return
            if (!sleepWarned && target - now <= 60_000L) { sleepWarned = true; presence("Sleeping in a minute · Press any button to keep watching") }
            if (target - now <= 1500L) { goToSleep(); return }
            handler.postDelayed(this, 5_000L)
        }
    }
    private fun renderSleep() {
        panelTitle.text = "Sleep timer"
        add(note("The video pauses and the screen goes dark. Continue watching keeps your spot."))
        val on = sleepAt > 0 || sleepAtEnd
        add(row("End of this video", null, sleepAtEnd) { setSleep(atEnd = true) }, sleepAtEnd)
        for (m in listOf(15, 30, 60, 90)) {
            val sel = sleepAt > 0 && !sleepAtEnd && kotlin.math.abs((sleepAt - System.currentTimeMillis()) / 60_000L - m) <= 1 && sleepMinutes == m
            add(row("In $m minutes", null, sel) { setSleep(minutes = m) }, sel)
        }
        add(row("Off", null, !on) { setSleep() }, !on)
    }
    private var sleepMinutes = 0
    private fun setSleep(minutes: Int = 0, atEnd: Boolean = false) {
        handler.removeCallbacks(sleepTick)
        sleepWarned = false
        sleepAtEnd = atEnd
        sleepMinutes = minutes
        sleepAt = if (minutes > 0) System.currentTimeMillis() + minutes * 60_000L else 0L
        sleepChip.badge(when { atEnd -> "end"; minutes > 0 -> "${minutes}m"; else -> "" })
        if (atEnd || minutes > 0) { handler.postDelayed(sleepTick, 5_000L); showToast(if (atEnd) "Sleeping when this ends" else "Sleeping in $minutes minutes") }
        closePanel()
    }
    private fun goToSleep() {
        playerOf()?.pause()
        nextCancelled = true // nothing starts by itself after we've gone to sleep
        sleepAt = 0L; sleepAtEnd = false; sleepChip.badge("")
        if (panelVisible) closePanel()
        hideBar()
        val dark = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            addView(TextView(activity).apply { text = "Sleeping · Press any button"; textSize = 15f; setTextColor(0x66FFFFFF) }, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
            alpha = 0f
        }
        root.addView(dark, FrameLayout.LayoutParams(-1, -1))
        dark.animate().alpha(1f).setDuration(1800).start()
        sleeping = dark
        activity.window.decorView.keepScreenOn = false
    }
    /** Any press wakes the TV from sleep, or keeps it awake when the minute's warning is up. */
    private fun wakeOrKeep(): Boolean {
        sleeping?.let { v -> root.removeView(v); sleeping = null; activity.window.decorView.keepScreenOn = true; showBar(); return true }
        if (sleepWarned && (sleepAt > 0 || sleepAtEnd)) { setSleep(); showToast("Sleep timer off"); }
        return false
    }

    /** Called when the player's tracks change, so an open panel shows the new state. */
    private var audioAuto = false
    private var audioPersonal = false
    private var reportedAudio = ""
    private var reportedStartingSubtitle = false
    /** Start on the viewer's own language (English, or the TV's language), not on whatever track the file lists first. */
    fun autoPickAudio() {
        val p = playerOf() ?: return
        val groups = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val entries = ArrayList<Triple<androidx.media3.common.Tracks.Group, Int, Format>>()
        for (g in groups) for (i in 0 until g.length) if (g.isTrackSupported(i)) entries += Triple(g, i, g.getTrackFormat(i))
        if (entries.isEmpty()) return
        val shared = info.optJSONObject("roomAudio")?.optJSONObject("state")
        if (shared != null && !audioPersonal) {
            val lang = shared.optString("language")
            var index = if (lang.isEmpty()) -1 else entries.indexOfFirst { (_, _, f) -> sameLang(f.language ?: "", lang) }
            if (index < 0 && lang.isEmpty()) index = shared.optInt("index", -1)
            if (index in entries.indices) {
                audioAuto = true
                val (g, i, _) = entries[index]
                if (!g.isTrackSelected(i)) p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
                return
            }
        }
        if (audioAuto) return
        audioAuto = true
        if (entries.size < 2) return
        val remembered = activity.getSharedPreferences("reddate-player", 0).getString("audio-language", "") ?: ""
        val mine = listOf(remembered, Locale.getDefault().getDisplayLanguage(Locale.ENGLISH).lowercase(), "english").filter { it.isNotEmpty() }.distinct()
        var idx = mine.firstNotNullOfOrNull { wanted -> entries.indexOfFirst { (_, _, f) ->
            var name = xyz.reddate.tv.Langs.nameOf(f.language)
            if (name.isEmpty() && !f.label.isNullOrEmpty()) name = xyz.reddate.tv.Langs.scan(f.label!!).firstOrNull() ?: ""
            name == wanted
        }.takeIf { it >= 0 } } ?: -1
        if (idx < 0) {
            // Tracks without language tags: the file name usually lists the languages in track order.
            val guess = guessedAudioLangs()
            if (guess.size == entries.size) idx = guess.indexOfFirst { it in mine }
        }
        if (idx < 0) return
        val (g, i, _) = entries[idx]
        if (g.isTrackSelected(i)) return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
    }

    private fun reportStartingAudio() {
        if (!info.optBoolean("isSettingsOwner")) return
        val p = playerOf() ?: return
        val entries = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            .flatMap { g -> (0 until g.length).filter { g.isTrackSupported(it) }.map { i -> g to i } }
        val index = entries.indexOfFirst { (g, i) -> g.isTrackSelected(i) }
        if (index < 0) return
        val (g, i) = entries[index]
        val f = g.getTrackFormat(i)
        val language = f.language ?: ""
        val label = f.label ?: ""
        val signature = "$language|$label|$index"
        if (signature == reportedAudio) return
        reportedAudio = signature
        activity.emitAudioChoice(language, label, index)
    }

    private fun reportStartingSubtitle() {
        if (!info.optBoolean("isSettingsOwner") || reportedStartingSubtitle) return
        val p = playerOf() ?: return
        if (p.currentTracks.groups.isEmpty()) return
        reportedStartingSubtitle = true
        if (activity.subtitlePersonal) { activity.emitCurrentSubtitle(); return }
        if (info.optJSONObject("roomSubtitle") != null) return
        val pick = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
            .flatMap { g -> (0 until g.length).map { i -> g to i } }.firstOrNull { (g, i) -> g.isTrackSelected(i) }
        if (pick != null) {
            val f = pick.first.getTrackFormat(pick.second)
            activity.shareEmbeddedSubtitle(f.language ?: "", f.label ?: "Subtitles")
        } else activity.shareSubtitleOff()
    }

    fun onTracksChanged() {
        autoPickAudio()
        reportStartingAudio()
        reportStartingSubtitle()
        selectSharedEmbedded()
        if (!restoreDone && playerOf()?.currentTracks?.groups?.any { it.type == C.TRACK_TYPE_TEXT } == true) { if (!restoreSubs()) pickInVideoDefault() }
        if (panelKind == "subs" || panelKind == "audio") {
            val had = panel.findFocus()
            val index = if (had != null) panelList.indexOfChild(had) else -1
            renderPanel()
            if (index >= 0 && index < panelList.childCount) panelList.getChildAt(index).requestFocus() else focusPanel()
        }
    }

    private val langNames = HashMap<String, String>()
    private fun langLabel(code: String?): String {
        if (code.isNullOrEmpty() || code == "und") return ""
        return langNames.getOrPut(code) {
            val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.getDefault())
            if (name.isNullOrEmpty() || name == code) code.uppercase() else name.replaceFirstChar { it.uppercase() }
        }
    }

    private fun trackLabel(f: Format, i: Int, audio: Boolean): String {
        val parts = mutableListOf<String>()
        val lang = langLabel(f.language)
        if (!f.label.isNullOrEmpty()) parts += f.label!! else if (lang.isNotEmpty()) parts += lang
        if (parts.isEmpty()) parts += "Track ${i + 1}"
        return parts.joinToString(" · ")
    }

    private fun codecLabel(f: Format): String = when {
        f.sampleMimeType?.contains("eac3") == true -> "Dolby Digital Plus"
        f.sampleMimeType?.contains("ac3") == true -> "Dolby Digital"
        f.sampleMimeType?.contains("dts") == true -> "DTS"
        f.sampleMimeType?.contains("truehd") == true -> "Dolby TrueHD"
        f.sampleMimeType?.contains("aac") == true -> "AAC"
        f.sampleMimeType?.contains("opus") == true -> "Opus"
        else -> ""
    }

    private fun capital(x: String) = x.replaceFirstChar { it.uppercase() }

    /** Languages the file name mentions, in order: used when the audio tracks themselves aren't labelled. */
    private fun guessedAudioLangs(): List<String> {
        val raw = try { java.net.URLDecoder.decode(activity.url, "UTF-8") } catch (_: Exception) { activity.url }
        return xyz.reddate.tv.Langs.scan("$raw ${activity.titleText}")
    }

    private fun renderAudio() {
        panelTitle.text = "Sound and picture"
        val p = playerOf() ?: return
        // Picture: black bars off (the picture is zoomed to the whole screen).
        val fill = activity.fillScreen
        add(row("Fill the screen", if (fill) "On: no black bars, the edges of widescreen films are cropped" else "Off: the whole picture, with black bars when the shape differs", fill) {
            activity.fillScreen = !fill; renderPanel(); focusSame("fill")
        }.also { it.tag = "fill" })
        val groups = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val total = groups.sumOf { g -> (0 until g.length).count { g.isTrackSupported(it) } }
        val guess = guessedAudioLangs()
        var n = 0
        var any = false
        for (g in groups) {
            for (i in 0 until g.length) {
                if (!g.isTrackSupported(i)) continue
                any = true
                val idx = n++
                val f = g.getTrackFormat(i)
                val sel = g.isTrackSelected(i)
                // The language: from the track, else its name, else (when the counts match) from the file name.
                var langName = xyz.reddate.tv.Langs.nameOf(f.language)
                var guessed = false
                if (langName.isEmpty() && !f.label.isNullOrEmpty()) langName = xyz.reddate.tv.Langs.scan(f.label!!).firstOrNull() ?: ""
                if (langName.isEmpty() && guess.size == total) { langName = guess[idx]; guessed = true }
                val flag = xyz.reddate.tv.Langs.flag(langName)
                val title = when {
                    langName.isNotEmpty() -> (if (flag.isNotEmpty()) "$flag  " else "") + capital(langName) + (if (!f.label.isNullOrEmpty() && !f.label!!.equals(langName, true)) " · ${f.label}" else "")
                    !f.label.isNullOrEmpty() -> f.label!!
                    else -> "Audio ${idx + 1}"
                }
                val ch = when (f.channelCount) { 1 -> "Mono"; 2 -> "Stereo"; 6 -> "5.1"; 8 -> "7.1"; else -> "" }
                val sub = listOf(codecLabel(f), ch, if (guessed) "language from the file name" else "").filter { it.isNotEmpty() }.joinToString(" · ")
                add(row(title, sub, sel) {
                    audioAuto = true
                    audioPersonal = true
                    activity.getSharedPreferences("reddate-player", 0).edit().putString("audio-language", langName).apply()
                    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
                }, sel)
            }
        }
        if (!any) add(note("This stream has a single audio track."))
    }

    // ---------- subtitles ----------
    private var subsLang = ""            // browsing one language's variants
    var externalUrl = ""                 // the online subtitle in use (read by us, not the player)

    private fun subLangKey(code: String): String = xyz.reddate.tv.Langs.nameOf(code).ifEmpty { code.lowercase() }

    private var subQuery = ""
    private var subSearch: EditText? = null
    private val subListBox: LinearLayout by lazy { LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL } }

    /** The subtitle on screen right now, in words. */
    private fun currentSubName(): String {
        val p = playerOf() ?: return "Off"
        if (externalUrl.isNotEmpty()) {
            val online = (0 until (info.optJSONArray("subs")?.length() ?: 0)).mapNotNull { info.optJSONArray("subs")?.optJSONObject(it) }
            val s = online.firstOrNull { it.optString("url") == externalUrl }
            if (s != null) return capital(subLangKey(s.optString("lang"))) + (s.optString("name").takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "")
            return "Online subtitle"
        }
        if (p.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) return "Off"
        for (g in p.currentTracks.groups) if (g.type == C.TRACK_TYPE_TEXT) for (i in 0 until g.length) if (g.isTrackSelected(i)) return trackLabel(g.getTrackFormat(i), i, false)
        return "Off"
    }

    private fun focusSide() {
        for (i in 0 until panelSide.childCount) { val c = panelSide.getChildAt(i); if (c.isFocusable) { c.requestFocus(); return } }
    }

    private fun subSample(): View {
        val a = activity
        val colors = intArrayOf(Color.WHITE, 0xFFFFE066.toInt(), 0xFF7FE3FF.toInt(), 0xFF9DFF9D.toInt())
        val sizes = floatArrayOf(15f, 19f, 24f, 29f)
        val fonts = arrayOf(Typeface.SANS_SERIF, Typeface.SERIF, Typeface.MONOSPACE, Typeface.create("casual", Typeface.NORMAL))
        val line = TextView(a).apply {
            text = "This is how they look"
            textSize = sizes[a.subSize.coerceIn(0, 3)]
            setTextColor(colors[a.subColor.coerceIn(0, 3)])
            typeface = fonts[a.subFont.coerceIn(0, 3)]
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(4), dp(10), dp(4))
            when (a.subBg.coerceIn(0, 3)) {
                1 -> background = GradientDrawable().apply { setColor(0xB0000000.toInt()); cornerRadius = dp(4).toFloat() }
                2 -> setShadowLayer(3f, 0f, 0f, Color.BLACK)
                3 -> setShadowLayer(6f, 2f, 3f, Color.BLACK)
            }
        }
        // A scene-like strip behind it, so colour and background read the way they will over a picture.
        return FrameLayout(a).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFF5A6B7A.toInt(), 0xFF2E3B2C.toInt(), 0xFF7A5A3E.toInt())).apply { cornerRadius = dp(12).toFloat() }
            setPadding(dp(12), dp(14), dp(12), dp(14))
            addView(line, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
            layoutParams = LinearLayout.LayoutParams(-1, dp(92)).apply { bottomMargin = dp(6) }
        }
    }

    private fun sideHeader(t: String) = text(13f, MUTED).apply { text = t; letterSpacing = 0.08f; setPadding(dp(14), dp(10), dp(14), dp(6)) }

    /** Subtitles, two columns: search and languages on the left; timing and look on the right. */
    private fun renderSubs() {
        panelTitle.text = "Subtitles"
        // ---- left: search, then the list
        val box = subSearch ?: EditText(activity).apply {
            hint = "Search languages"
            setHintTextColor(MUTED)
            setTextColor(Color.WHITE)
            textSize = 17f
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            background = focusBackground(radius = 12, idle = 0x26FFFFFF, focused = 0x4DFFFFFF)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            setOnClickListener { (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, 0) }
            setOnEditorActionListener { v, _, _ ->
                (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(v.windowToken, 0)
                for (i in 0 until subListBox.childCount) { val c = subListBox.getChildAt(i); if (c.isFocusable) { c.requestFocus(); break } }
                true
            }
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) { val q = e?.toString().orEmpty(); if (q != subQuery) { subQuery = q; subsLang = ""; fillSubList() } }
                override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            })
        }.also { subSearch = it }
        if (box.text.toString() != subQuery) box.setText(subQuery)
        (box.parent as? ViewGroup)?.removeView(box)
        (subListBox.parent as? ViewGroup)?.removeView(subListBox)
        add(box.apply { layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) } })
        // What's on now, then the way to style it, then every language.
        add(sideHeader("SHOWING NOW"))
        add(row(currentSubName(), null, false, null))
        add(row("Style & timing", "Size, colour, position, sync  ›", false) { openPanel("substyle") }.also { it.tag = "stylebtn" })
        add(sideHeader("LANGUAGES"))
        add(subListBox.apply { layoutParams = LinearLayout.LayoutParams(-1, -2) })
        fillSubList()

    }

    /** The left column's list: languages (or one language's options), narrowed by the search. */
    private fun fillSubList() {
        subListBox.removeAllViews()
        fun put(v: View, checked: Boolean = false) { if (checked) v.tag = "checked"; subListBox.addView(v) }
        val p = playerOf() ?: return
        val q = subQuery.trim().lowercase()
        val online = (0 until (info.optJSONArray("subs")?.length() ?: 0)).mapNotNull { info.optJSONArray("subs")?.optJSONObject(it) }
        // One language's variants: the release names and where they came from.
        if (subsLang.isNotEmpty()) {
            val variants = online.filter { subLangKey(it.optString("lang")) == subsLang }
            put(row("‹  All languages", null, false) { subsLang = ""; fillSubList(); focusList() })
            put(text(13f, MUTED).apply { text = "${(xyz.reddate.tv.Langs.flag(subsLang) + " " + capital(subsLang)).trim().uppercase()} · ${variants.size} OPTIONS"; letterSpacing = 0.06f; setPadding(dp(14), dp(10), dp(14), dp(6)) })
            variants.forEachIndexed { k, s ->
                val u = s.optString("url")
                val name = s.optString("name").ifEmpty { "Option ${k + 1}" }
                val sub = listOf(if (k == 0) "Best match" else "", s.optString("addon")).filter { it.isNotEmpty() }.joinToString(" · ")
                val sel = u == externalUrl
                put(row(name, sub, sel) { addOnlineSub(s) }, sel)
            }
            return
        }
        val textOff = p.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
        val noneOnline = externalUrl.isEmpty()
        var anySelected = externalUrl.isNotEmpty()
        val inPlayer = mutableListOf<Triple<androidx.media3.common.Tracks.Group, Int, Format>>()
        for (g in p.currentTracks.groups) {
            if (g.type != C.TRACK_TYPE_TEXT) continue
            for (i in 0 until g.length) if (g.isTrackSupported(i)) {
                inPlayer += Triple(g, i, g.getTrackFormat(i))
                if (noneOnline && !textOff && g.isTrackSelected(i)) anySelected = true
            }
        }
        fun matches(vararg t: String) = q.isEmpty() || t.any { it.lowercase().contains(q) }
        if (q.isEmpty()) put(row("Off", null, !anySelected) {
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            activity.clearExternalSubtitle(); externalUrl = ""
            activity.emitSubPref("off")
            activity.shareSubtitleOff()
            subPref = "off"
            rememberSubs("off", "")
            fillSubList()
        }, !anySelected)
        var shown = 0
        val shownIn = inPlayer.filter { (_, i, f) -> matches(xyz.reddate.tv.Langs.nameOf(f.language), trackLabel(f, i, false), f.language ?: "") }
        if (shownIn.isNotEmpty()) put(sideHeader("IN THE VIDEO"))
        for ((g, i, f) in shownIn) {
            val sel = noneOnline && !textOff && g.isTrackSelected(i)
            val lang = xyz.reddate.tv.Langs.nameOf(f.language)
            val flag = xyz.reddate.tv.Langs.flag(lang)
            val title = (if (flag.isNotEmpty()) "$flag  " else "") + trackLabel(f, i, false)
            shown++
            put(row(title, null, sel) {
                activity.clearExternalSubtitle(); externalUrl = ""
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
                f.language?.let { activity.emitSubPref(it); subPref = it }
                activity.shareEmbeddedSubtitle(f.language ?: "", trackLabel(f, i, false))
                rememberSubs("in", f.language ?: "", trackLabel(f, i, false))
                fillSubList()
            }, sel)
        }
        if (online.isNotEmpty()) {
            val mine = setOf(subPref, Locale.getDefault().isO3Language, Locale.getDefault().language).filter { it.isNotEmpty() && it != "off" }
            val groups = online.groupBy { subLangKey(it.optString("lang")) }
                .filter { (k, l) -> matches(k, capital(k), *l.map { it.optString("name") }.toTypedArray()) }
            val order = groups.keys.sortedBy { k -> if (mine.any { m -> sameLang(m, groups[k]!!.first().optString("lang")) }) 0 else 1 }
            if (order.isNotEmpty()) put(sideHeader("ONLINE"))
            for (k in order) {
                val list = groups[k]!!
                val flag = xyz.reddate.tv.Langs.flag(k)
                val title = (if (flag.isNotEmpty()) "$flag  " else "") + capital(k)
                val using = list.any { it.optString("url") == externalUrl }
                shown++
                if (list.size == 1) put(row(title, null, using) { addOnlineSub(list[0]) }, using)
                else put(row(title, "${list.size} options  ›", using) { subsLang = k; fillSubList(); focusList() }, using)
            }
        }
        if (shown == 0) put(note(when {
            q.isNotEmpty() -> "No subtitles match “${subQuery.trim()}”."
            info.optBoolean("subsLoading") -> "Looking for subtitles…"
            else -> "No subtitles found for this video."
        }))
    }

    private fun focusList() {
        for (i in 0 until subListBox.childCount) { val c = subListBox.getChildAt(i); if (c.isFocusable && c.tag == "checked") { c.requestFocus(); return } }
        for (i in 0 until subListBox.childCount) { val c = subListBox.getChildAt(i); if (c.isFocusable) { c.requestFocus(); return } }
    }

    // ---------- subtitle style panel ----------
    private val sizeNames = listOf("Small", "Medium", "Large", "Huge")
    private val posNames = listOf("Lowest", "Low", "Middle", "High", "Highest")
    private val colorNames = listOf("White", "Yellow", "Cyan", "Green")
    private val bgNames = listOf("None", "Box", "Outline", "Shadow")
    private val fontNames = listOf("Sans", "Serif", "Mono", "Casual")

    private fun fmtDelay(ms: Long): String = (if (ms >= 0) "+" else "−") + String.format(Locale.US, "%d ms", kotlin.math.abs(ms))

    private fun renderSubStyle() {
        panelTitle.text = "Style & timing"
        addFixed(subSample())
        val a = activity
        fun adj(i: Int, label: String, value: String) = add(row(label, "‹  $value  ›", false) { adjustStyle(i, 1) }.also { it.tag = "adj:$i" })
        add(row("Auto-sync subtitles", if (autoSyncing) autoSyncLine else if (autoSyncLine.isNotEmpty()) autoSyncLine else "Matches them to the speech while the video plays", false) {
            if (autoSyncing) { finishAutoSync(false, "Cancelled."); } else { autoSyncLine = ""; autoSyncSubtitles() }
        }.also { it.tag = "autosync" })
        adj(0, "Size", sizeNames[a.subSize.coerceIn(0, 3)])
        adj(1, "Position", posNames[a.subPos.coerceIn(0, 4)])
        adj(2, "Colour", colorNames[a.subColor.coerceIn(0, 3)])
        adj(3, "Background", bgNames[a.subBg.coerceIn(0, 3)])
        adj(4, "Font", fontNames[a.subFont.coerceIn(0, 3)])
        adj(5, "Sync room subtitles", fmtDelay(a.subDelayMs))
        add(note(if (a.subs.cues.isEmpty()) "Delay works on online subtitles. Pick one from the list first." else "Left and right change the value. Press OK on Sync to reset it."))
        add(row("Reset look") { a.subSize = 1; a.subPos = 1; a.subColor = 0; a.subBg = 1; a.subFont = 0; a.subDelayMs = 0; a.shareSubtitleTiming(); renderPanel(); focusPanel() })
        add(row("Done") { openPanel("subs") })
    }

    // ---------- auto-sync: line the subtitles up with the speech ----------
    private var autoSyncing = false
    private val AUTO_SYNC_SECONDS = 40

    private fun autoSyncSubtitles() {
        val a = activity
        if (autoSyncing) return
        if (a.subs.cues.isEmpty()) { toastBar("Pick an online subtitle first. Auto-sync works on those."); return }
        if (!a.audioTap.supported) { toastBar("This stream's sound can't be listened to (surround passthrough). Use the delay buttons."); return }
        val p = playerOf() ?: return
        if (!p.playWhenReady) { toastBar("Press play first: it listens while the video plays."); return }
        autoSyncing = true
        a.audioTap.begin(p.currentPosition)
        var left = AUTO_SYNC_SECONDS
        val tick = object : Runnable {
            override fun run() {
                if (!autoSyncing) return
                val pl = playerOf()
                if (pl == null || !pl.playWhenReady) { finishAutoSync(false, "Stopped: the video was paused."); return }
                left--
                if (left <= 0) { finishAutoSync(true, ""); return }
                if (panelKind == "substyle" || panelKind == "subs") { autoSyncLine = "Listening… ${left}s"; renderPanel(); focusSame("autosync") }
                handler.postDelayed(this, 1000)
            }
        }
        autoSyncLine = "Listening… ${left}s"
        if (panelKind == "substyle" || panelKind == "subs") { renderPanel(); focusSame("autosync") }
        handler.postDelayed(tick, 1000)
    }

    private var autoSyncLine = ""

    private fun finishAutoSync(ok: Boolean, why: String) {
        autoSyncing = false
        val a = activity
        val loud = a.audioTap.stop()
        if (!ok) { autoSyncLine = why; toastBar(why); if (panelKind == "substyle" || panelKind == "subs") { renderPanel(); focusSame("autosync") }; return }
        Thread {
            val r = SubSync.solve(loud, a.audioTap.startMs.coerceAtLeast(0), a.audioTap.binMs, a.subs.cues)
            a.runOnUiThread {
                DevLog.log("autosync", "bins=${loud.size} start=${a.audioTap.startMs} delay=${r.delayMs} z=${r.confidence} why=${r.reason}")
                if (r.reason.isEmpty()) {
                    a.subDelayMs = (a.subDelayMs + r.delayMs).coerceIn(-30_000L, 30_000L)
                    rememberDelay()
                    autoSyncLine = "Synced: ${fmtDelay(a.subDelayMs)}"
                    toastBar("Subtitles synced (${fmtDelay(a.subDelayMs)})")
                } else {
                    autoSyncLine = r.reason
                    toastBar(r.reason)
                }
                if (panelKind == "substyle" || panelKind == "subs") { renderPanel(); focusSame("autosync") }
            }
        }.start()
    }

    private fun adjustStyle(i: Int, dir: Int) {
        val a = activity
        fun cyc(v: Int, n: Int) = ((v + dir) % n + n) % n
        when (i) {
            0 -> a.subSize = (a.subSize + dir).coerceIn(0, 3)
            1 -> a.subPos = (a.subPos + dir).coerceIn(0, 4)
            2 -> a.subColor = cyc(a.subColor, 4)
            3 -> a.subBg = cyc(a.subBg, 4)
            4 -> a.subFont = cyc(a.subFont, 4)
            5 -> {
                if (a.subs.cues.isEmpty()) { shiftNeedsOnline(dir * 50L); return }
                a.subDelayMs = (a.subDelayMs + dir * 50L).coerceIn(-30_000L, 30_000L)
                rememberDelay()
            }
        }
        val keep = i
        renderPanel()
        focusSame("adj:$keep")
    }

    /** Subtitles inside the video file can't be re-timed; use the online one in the same language, then shift it. */
    private fun shiftNeedsOnline(delta: Long) {
        val p = playerOf() ?: return
        val online = (0 until (info.optJSONArray("subs")?.length() ?: 0)).mapNotNull { info.optJSONArray("subs")?.optJSONObject(it) }
        var lang = ""
        if (!p.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
            for (g in p.currentTracks.groups) if (g.type == C.TRACK_TYPE_TEXT) for (i in 0 until g.length) if (g.isTrackSelected(i)) lang = g.getTrackFormat(i).language ?: lang
        }
        if (lang.isEmpty() && subPref != "off") lang = subPref
        val match = online.firstOrNull { lang.isNotEmpty() && sameLang(it.optString("lang"), lang) }
        if (match == null) { toastBar("Timing can be changed on online subtitles. None found for this language."); return }
        toastBar("Switching to the online subtitle so its timing can move…")
        addOnlineSub(match) {
            activity.subDelayMs = (activity.subDelayMs + delta).coerceIn(-30_000L, 30_000L)
            rememberDelay()
            if (panelKind == "subs" || panelKind == "substyle") { renderPanel(); focusSame("adj:5") }
        }
    }

    private fun adjustFocused(dir: Int): Boolean {
        val f = panel.findFocus() ?: return true
        val tag = (f.tag as? String) ?: return true
        if (!tag.startsWith("adj:")) return true
        val i = tag.removePrefix("adj:").toIntOrNull() ?: return true
        adjustStyle(i, dir)
        return true
    }

    // ---------- online subtitles (read by the app, so the picture never restarts) ----------
    private fun addOnlineSub(s: JSONObject, user: Boolean = true, after: (() -> Unit)? = null) {
        if (user) activity.subtitlePersonal = true
        val u = s.optString("url")
        if (!u.startsWith("https://") && !u.startsWith("http://")) return
        val lang = s.optString("lang")
        subPref = lang
        activity.emitSubPref(lang)
        panelList.removeAllViews()
        add(note("Loading subtitles…"))
        activity.useExternalSubtitle(u) { ok ->
            if (ok) {
                externalUrl = u; toastBar("Subtitles on")
                if (user) { rememberSubs("online", lang, s.optString("name"), u); activity.shareExternalSubtitle(lang, s.optString("label", lang)) }
            } else toastBar("Couldn't load those. Try another option.")
            if (panelKind == "subs") { renderPanel(); focusPanel() }
            if (ok) after?.invoke()
        }
    }

    // ---------- remembering the subtitle choice per show / movie (for Continue watching and the next episode) ----------
    private val subMem by lazy { activity.getSharedPreferences("submem", android.content.Context.MODE_PRIVATE) }
    private fun showKey() = info.optString("show").ifEmpty { info.optString("current") }
    /** Subtitle choices belong to the profile that made them. */
    private fun pid() = xyz.reddate.tv.ReddateApp.instance.getSharedPreferences("session", android.content.Context.MODE_PRIVATE).getString("pid", "").orEmpty()
    private fun itemKey() = info.optString("current")
    private var restoreDone = false

    /** Remember what was picked: off, a track in the video (by language), or an online one (and which). */
    private fun rememberSubs(kind: String, lang: String, label: String = "", url: String = "") {
        restoreDone = true // the viewer chose: nothing to restore any more
        val sk = showKey(); if (sk.isEmpty()) return
        subMem.edit()
            .putString("s:${pid()}:$sk", JSONObject().put("kind", kind).put("lang", lang).put("label", label).toString())
            .putString("i:${pid()}:${itemKey()}", JSONObject().put("url", url).put("delay", activity.subDelayMs).toString())
            .apply()
    }

    private fun rememberDelay() {
        activity.shareSubtitleTiming()
        val ik = itemKey(); if (ik.isEmpty() || externalUrl.isEmpty()) return
        subMem.edit().putString("i:${pid()}:$ik", JSONObject().put("url", externalUrl).put("delay", activity.subDelayMs).toString()).apply()
    }

    /** Put back what this viewer chose for this show last time. True when there's nothing more to do. */
    private fun restoreSubs(): Boolean {
        if (info.optBoolean("live")) return true
        if (restoreDone) return true
        val sk = showKey(); if (sk.isEmpty()) return false
        val mem = subMem.getString("s:${pid()}:$sk", null)?.let { try { JSONObject(it) } catch (_: Exception) { null } } ?: return false
        val item = subMem.getString("i:${pid()}:${itemKey()}", null)?.let { try { JSONObject(it) } catch (_: Exception) { null } }
        val p = playerOf() ?: return false
        val lang = mem.optString("lang")
        val online = (0 until (info.optJSONArray("subs")?.length() ?: 0)).mapNotNull { info.optJSONArray("subs")?.optJSONObject(it) }
        fun useOnline(): Boolean {
            val exact = item?.optString("url")?.takeIf { it.isNotEmpty() }?.let { u -> online.firstOrNull { it.optString("url") == u } }
            val pick = exact ?: online.firstOrNull { lang.isNotEmpty() && sameLang(it.optString("lang"), lang) } ?: return false
            restoreDone = true
            val delay = if (exact != null) item.optLong("delay", 0L) else 0L
            addOnlineSub(pick, user = false) { if (delay != 0L) { activity.subDelayMs = delay; rememberDelay(); if (panelKind == "subs") renderPanel() } }
            return true
        }
        when (mem.optString("kind")) {
            "off" -> {
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                restoreDone = true; return true
            }
            "in" -> {
                val tracks = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
                if (tracks.isEmpty()) return if (online.isNotEmpty() && useOnline()) true else false
                val label = mem.optString("label")
                var best: Pair<androidx.media3.common.Tracks.Group, Int>? = null
                for (g in tracks) for (i in 0 until g.length) {
                    val f = g.getTrackFormat(i)
                    if (!sameLang(f.language ?: "", lang)) continue
                    if (best == null || (label.isNotEmpty() && trackLabel(f, i, false) == label)) best = g to i
                }
                val b = best ?: return useOnline()
                activity.clearExternalSubtitle(); externalUrl = ""
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(b.first.mediaTrackGroup, b.second)).build()
                restoreDone = true; return true
            }
            "online" -> return useOnline()
        }
        return false
    }

    /** First time on this show or movie: if the video has its own subtitles, turn them on (the viewer can change it). */
    private fun pickInVideoDefault(): Boolean {
        if (info.optBoolean("live")) return true
        if (restoreDone || externalUrl.isNotEmpty()) return restoreDone
        val sk = showKey()
        if (sk.isEmpty() || subMem.contains("s:${pid()}:$sk")) return false
        val p = playerOf() ?: return false
        val groups = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
        if (groups.isEmpty()) return false
        val wants = listOf(subPref.takeIf { it.isNotEmpty() && it != "off" }, Locale.getDefault().language, "en").filterNotNull()
        var pick: Pair<androidx.media3.common.Tracks.Group, Int>? = null
        loop@ for (w in wants) for (g in groups) for (i in 0 until g.length) {
            if (g.isTrackSupported(i) && sameLang(g.getTrackFormat(i).language ?: "", w)) { pick = g to i; break@loop }
        }
        if (pick == null) pick = groups.firstNotNullOfOrNull { g -> (0 until g.length).firstOrNull { g.isTrackSupported(it) }?.let { g to it } }
        val b = pick ?: return false
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setOverrideForType(TrackSelectionOverride(b.first.mediaTrackGroup, b.second)).build()
        restoreDone = true
        return true
    }

    /** Pick the language this viewer used last time, once the room's subtitle list arrives. */
    fun autoPickPreferred() {
        // Not before the video is ready: until then its own subtitle tracks aren't known, and an online
        // one would be picked over a perfectly good track inside the file. Ready calls this again.
        val pl = playerOf() ?: return
        if (pl.playbackState != androidx.media3.common.Player.STATE_READY && pl.currentTracks.groups.none { it.type == C.TRACK_TYPE_TEXT }) return
        if (restoreSubs()) return
        if (pickInVideoDefault()) return
        if (subPref.isEmpty() || subPref == "off" || externalUrl.isNotEmpty()) return
        val p = playerOf() ?: return
        // A matching track inside the video wins.
        for (g in p.currentTracks.groups) if (g.type == C.TRACK_TYPE_TEXT) for (i in 0 until g.length) {
            val lang = g.getTrackFormat(i).language ?: continue
            if (sameLang(lang, subPref)) {
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
                return
            }
        }
        val online = info.optJSONArray("subs") ?: return
        for (k in 0 until online.length()) {
            val s = online.optJSONObject(k) ?: continue
            if (sameLang(s.optString("lang"), subPref)) { addOnlineSub(s, user = false); return }
        }
    }

    private fun sameLang(a: String, b: String): Boolean {
        fun norm(x: String) = try { Locale.forLanguageTag(x).isO3Language } catch (_: Exception) { x }
        return a.equals(b, true) || norm(a).equals(norm(b), true)
    }

    private fun palette(name: String): Int {
        val c = intArrayOf(0xFFC9F27A.toInt(), 0xFF9AD1FF.toInt(), 0xFFFFB27A.toInt(), 0xFFE0A6FF.toInt(), 0xFFFFE08A.toInt(), 0xFF8FE3C9.toInt())
        return c[(name.lowercase().fold(0) { a, ch -> a * 31 + ch.code } and 0x7fffffff) % c.size]
    }

    private fun avatarView(name: String, sizeDp: Int, group: Boolean = false): View = TextView(activity).apply {
        text = if (group) "All" else name.trim().take(1).uppercase().ifEmpty { "?" }
        gravity = Gravity.CENTER
        setTextColor(0xFF1A0F09.toInt())
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        textSize = if (group) 12f else 18f
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (group) 0x33000000 else palette(name)) }
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    /** A person (or everyone) you can invite: a coloured circle, their name, and what pressing does. */
    private fun personRow(name: String, sub: String, everyone: Boolean, done: Boolean, onClick: () -> Unit): View {
        val l = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(14), dp(10))
            background = focusBackground(radius = 14, idle = if (everyone) ACCENT else 0x26FFFFFF, focused = Color.WHITE)
            isFocusable = true
            isClickable = true
            setOnClickListener { onClick() }
        }
        l.addView(avatarView(name, 40, everyone))
        val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; isDuplicateParentStateEnabled = true }
        texts.addView(text(17f, Color.WHITE).apply {
            text = name; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; isDuplicateParentStateEnabled = true
            setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xFF101010.toInt(), if (everyone) 0xFF1A0F09.toInt() else Color.WHITE)))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        if (sub.isNotEmpty()) texts.addView(text(12f, MUTED).apply {
            text = sub; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; isDuplicateParentStateEnabled = true
            setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xCC101010.toInt(), if (everyone) 0xCC1A0F09.toInt() else MUTED)))
        })
        l.addView(texts, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(12) })
        l.addView(text(14f, Color.WHITE).apply {
            text = if (done) "✓" else ""; isDuplicateParentStateEnabled = true
            setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xFF101010.toInt(), if (everyone) 0xFF1A0F09.toInt() else ACCENT)))
        })
        l.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) }
        return l
    }

    private var inviteDevices: List<Triple<String, String, String>>? = null
    private var invitedIds = mutableSetOf<String>()

    private suspend fun fetchDevices(): List<Triple<String, String, String>>? = try {
        (xyz.reddate.tv.Engine.call("devices") as? JSONArray)?.let { arr ->
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.map {
                Triple(it.optString("id"), it.optString("profile").ifEmpty { it.optString("device") }, if (it.optString("profile").isNotEmpty()) it.optString("device") else "")
            }
        } ?: emptyList()
    } catch (_: Exception) { null }

    // While Invite is open, look again every few seconds: a phone or browser tab opened just now appears.
    private val inviteRefresh: Runnable = object : Runnable {
        override fun run() {
            if (panelKind != "invite") return
            val self = this
            kotlinx.coroutines.MainScope().launch {
                val fresh = fetchDevices()
                if (panelKind != "invite") return@launch
                if (fresh != null && fresh != inviteDevices) {
                    val focusedTag = root.findFocus()?.tag as? String
                    inviteDevices = fresh
                    renderPanel()
                    if (focusedTag != null) focusSame(focusedTag) else focusPanel()
                }
                handler.removeCallbacks(self)
                handler.postDelayed(self, 3000)
            }
        }
    }

    private fun renderInvite() {
        panelTitle.text = "Invite"
        val link = info.optString("invite")
        val code = info.optString("room")
        if (link.isEmpty()) { add(note("The room link isn't ready yet.")); return }
        val devices = inviteDevices
        if (devices == null) {
            add(note("Looking for your profiles…"))
            kotlinx.coroutines.MainScope().launch {
                inviteDevices = fetchDevices() ?: emptyList()
                if (panelKind == "invite") { renderPanel(); focusPanel() }
                handler.removeCallbacks(inviteRefresh)
                handler.postDelayed(inviteRefresh, 3000)
            }
            return
        }
        // Everyone else signed in to this account (other profiles, other TVs and phones) gets a pop-up.
        if (devices.isNotEmpty()) {
            add(personRow("Invite all my profiles", "They get a pop-up to join; you control playback", true, invitedIds.size >= devices.size) {
                activity.emitAction("invite-all"); invitedIds = devices.map { it.first }.toMutableSet(); toastBar("Invites sent"); closePanel()
            })
            for ((id, name, device) in devices) {
                add(personRow(name, device, false, id in invitedIds) {
                    kotlinx.coroutines.MainScope().launch {
                        try { xyz.reddate.tv.Engine.call("inviteDevice", JSONObject().put("id", id)); invitedIds.add(id); toastBar("Invite sent to $name") } catch (_: Exception) { toastBar("Couldn't send that invite") }
                        if (panelKind == "invite") { renderPanel(); focusSame("p:$id") }
                    }
                }.also { it.tag = "p:$id" })
            }
        } else add(note("No other profiles are open right now."))
        if (code.isNotEmpty()) {
            add(text(13f, MUTED).apply { text = "PARTY CODE · ANYONE WITH REDDATE TV CAN JOIN"; letterSpacing = 0.06f; setPadding(dp(4), dp(14), 0, 0) })
            add(text(34f, Color.WHITE, bold = true).apply { text = code; letterSpacing = 0.06f; setPadding(dp(4), dp(2), 0, dp(10)) })
            // Scan to join from a phone or computer.
            val bmp = try {
                val m = com.google.zxing.qrcode.QRCodeWriter().encode(link, com.google.zxing.BarcodeFormat.QR_CODE, 360, 360, mapOf(com.google.zxing.EncodeHintType.MARGIN to 0))
                val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) Color.BLACK else Color.WHITE }
                android.graphics.Bitmap.createBitmap(px, m.width, m.height, android.graphics.Bitmap.Config.ARGB_8888)
            } catch (_: Exception) { null }
            // The QR code with the typed address beside it, so the whole invite fits on screen.
            val side = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(dp(4), 0, 0, dp(10))
            }
            if (bmp != null) side.addView(android.widget.ImageView(activity).apply {
                setImageBitmap(bmp)
                setPadding(dp(6), dp(6), dp(6), dp(6))
                background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(Color.WHITE) }
                layoutParams = LinearLayout.LayoutParams(dp(112), dp(112)).apply { rightMargin = dp(14) }
            })
            side.addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(text(13f, MUTED).apply { text = if (bmp != null) "Scan to join from a phone or computer" else "Join from a phone or computer" })
                addView(text(13f, MUTED).apply { text = "Or go to"; setPadding(0, dp(8), 0, 0) })
                // For a computer or a phone without a scanner: the same address, typed.
                addView(text(15f, Color.WHITE, bold = true).apply { text = link.removePrefix("https://").removePrefix("http://") })
            })
            add(side)
        }
        // Something focusable so Back and the remote behave inside the panel.
        add(row("Done") { closePanel() })
    }

    private fun renderPeople() {
        panelTitle.text = "Who's here"
        val people = info.optJSONArray("people") ?: JSONArray()
        if (!isGuest) add(row("Invite someone", "Link, QR code or your profiles") { openPanel("invite") })
        if (people.length() == 0) { add(note("Just you for now.")); return }
        val iAmHost = info.optBoolean("hostOnly") && info.optBoolean("isHost", true)
        // The host decides whether guests can pause and play for everyone.
        if (iAmHost && kickTarget == null) {
            val on = info.optBoolean("guestsCanPause", false)
            add(row("Guests can pause and play", if (on) "On: anyone pauses for everyone" else "Off: only hosts control playback", on) {
                activity.emitAction(if (on) "guests-pause-off" else "guests-pause-on")
                info.put("guestsCanPause", !on)
                renderPanel(); focusSame("gp")
            }.also { it.tag = "gp" })
        }
        val target = kickTarget
        if (target != null) {
            // What to do with this person: host rights, or remove them.
            var isHostNow = false; var isMain = false
            for (k in 0 until people.length()) people.optJSONObject(k)?.let { if (it.optString("id") == target.first) { isHostNow = it.optBoolean("host"); isMain = it.optBoolean("main") } }
            add(text(17f, Color.WHITE, bold = true).apply { text = target.second; setPadding(dp(4), 0, dp(4), dp(4)) })
            add(text(14f, MUTED).apply { text = if (isMain) "Main host" else if (isHostNow) "Host: can pause, skip, change the video and remove people" else "Guest"; setPadding(dp(4), 0, dp(4), dp(14)) })
            if (!isMain) {
                add(row(if (isHostNow) "Remove host rights" else "Make host", if (isHostNow) "They go back to being a guest" else "They can pause, skip, change the video and remove people") {
                    activity.emitSetHost(target.first, !isHostNow); kickTarget = null; toastBar(if (isHostNow) "${target.second} is no longer a host" else "${target.second} is now a host"); renderPanel(); focusPanel()
                }, true)
                add(row("Remove ${target.second} from the party", "They go back to Home. You can invite them again.") { activity.emitKick(target.first); kickTarget = null; toastBar("${target.second} was removed"); renderPanel(); focusPanel() })
            }
            add(row("Back") { kickTarget = null; renderPanel(); focusPanel() })
            return
        }
        for (k in 0 until people.length()) {
            val pp = people.optJSONObject(k) ?: continue
            val you = pp.optBoolean("you")
            val name = pp.optString("name").ifEmpty { "Guest" }
            val status = when {
                pp.optBoolean("host") && you -> "You · host"
                pp.optBoolean("main") -> "Main host"
                pp.optBoolean("host") -> "Host"
                pp.optBoolean("buffering") -> "Loading…"
                you -> "You"
                iAmHost -> "Guest · press OK for host options"
                else -> "Watching"
            }
            val id = pp.optString("id")
            if (iAmHost && !you && id.isNotEmpty()) add(row(name, status) { kickTarget = id to name; renderPanel(); focusPanel() })
            else add(row(name, status))
        }
        add(row("Invite someone") { openPanel("invite") })
    }

    private fun qr(text: String, size: Int): Bitmap? = try {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
        val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) Color.BLACK else Color.WHITE }
        Bitmap.createBitmap(px, m.width, m.height, Bitmap.Config.ARGB_8888)
    } catch (_: Exception) { null }

    // ---------- episodes (shows) ----------
    private val thumbs = HashMap<String, Bitmap>()
    private fun loadThumb(url: String, into: ImageView) {
        if (!url.startsWith("https://")) return
        thumbs[url]?.let { into.setImageBitmap(it); return }
        Thread {
            try {
                val bmp = java.net.URL(url).openStream().use { android.graphics.BitmapFactory.decodeStream(it) } ?: return@Thread
                handler.post { thumbs[url] = bmp; if (into.tag == url) into.setImageBitmap(bmp) }
            } catch (_: Exception) { }
        }.start()
    }

    private fun renderEpisodes() {
        panelTitle.text = "Episodes"
        val eps = info.optJSONArray("episodes") ?: JSONArray()
        val list = (0 until eps.length()).mapNotNull { eps.optJSONObject(it) }
        val current = info.optString("current")
        val now = list.firstOrNull { it.optString("id") == current }
        if (now != null) {
            addFixed(text(12f, MUTED).apply { text = "NOW PLAYING"; letterSpacing = 0.08f })
            addFixed(text(16f, Color.WHITE, bold = true).apply { text = "S${now.optInt("season")}E${now.optInt("episode")} · ${now.optString("title")}"; setPadding(0, dp(2), 0, dp(12)) })
        }
        // Autoplay: the next episode starts by itself a few seconds after this one ends.
        val auto = info.optBoolean("autoNext", true)
        addFixed(row("Autoplay next episode", if (auto) "On  ·  starts 4 seconds after this one ends" else "Off  ·  you pick the next one", auto) {
            if (!canChange) { denyChange(); return@row }
            info.put("autoNext", !auto) // show it at once; the page confirms
            activity.emitAutoNext(!auto)
            renderPanel(); focusSame("autonext")
        }.also { it.tag = "autonext" })
        val seasons = list.map { it.optInt("season") }.distinct().sorted()
        if (episodeSeason !in seasons) episodeSeason = now?.optInt("season") ?: seasons.firstOrNull() ?: 1
        // Seasons: a row of chips (scrolls sideways when there are many).
        val chipRow = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val chipId = View.generateViewId()
        var currentChip: View? = null
        seasons.forEach { s ->
            val c = chip(if (s == 0) "Specials" else "Season $s") { episodeSeason = s; renderPanel(); focusSame("season:$s") }.apply {
                tag = "season:$s"
                // Landing on a season shows its episodes, no OK needed.
                setOnFocusChangeListener { _, has ->
                    if (has && episodeSeason != s) handler.post { if (panelKind == "episodes" && episodeSeason != s) { episodeSeason = s; renderPanel(); focusSame("season:$s") } }
                }
                if (s == episodeSeason) { id = chipId; setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(INK, ACCENT))) }
            }
            if (s == episodeSeason) currentChip = c
            chipRow.addView(c)
        }
        val chipScroll = android.widget.HorizontalScrollView(activity).apply { isHorizontalScrollBarEnabled = false; addView(chipRow); layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) } }
        addFixed(chipScroll)
        // Open with the current season in view, so the remote doesn't have to travel from Season 1. Done when the
        // chips have really been laid out (their positions are 0 until then), and once more a moment later.
        currentChip?.let { c ->
            fun go() { if (c.left > 0) chipScroll.scrollTo((c.left - dp(8)).coerceAtLeast(0), 0) }
            c.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
                override fun onLayoutChange(v: View?, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or2: Int, ob: Int) { go(); c.removeOnLayoutChangeListener(this) }
            })
            chipScroll.post { go() }
            chipScroll.postDelayed({ go() }, 150)
        }
        list.filter { it.optInt("season") == episodeSeason }.forEach { e ->
            val id = e.optString("id")
            val playing = id == current
            val row = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), dp(8), dp(8), dp(8))
                background = focusBackground(radius = 10, idle = if (playing) 0x33E8602C else Color.TRANSPARENT, focused = Color.WHITE)
                isFocusable = true
                isClickable = true
                tag = if (playing) "checked" else null
                nextFocusUpId = chipId // up from the episodes lands on the current season's chip
                setOnClickListener { if (!canChange) { denyChange(); return@setOnClickListener }; if (!playing) { activity.emitEpisode(id, "S${e.optInt("season")}E${e.optInt("episode")}" + e.optString("title").let { t -> if (t.isEmpty()) "" else " · $t" }); closePanel() } }
            }
            val thumb = ImageView(activity).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(0xFF25201D.toInt())
                tag = e.optString("thumbnail")
                loadThumb(e.optString("thumbnail"), this)
            }
            row.addView(thumb, LinearLayout.LayoutParams(dp(96), dp(54)).apply { rightMargin = dp(10) })
            val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; isDuplicateParentStateEnabled = true }
            texts.addView(text(14f, Color.WHITE, bold = true).apply {
                text = "E${e.optInt("episode")} · ${e.optString("title")}"; maxLines = 2; ellipsize = TextUtils.TruncateAt.END
                setTextColor(focusText()); isDuplicateParentStateEnabled = true
            })
            val facts = listOf(if (e.optString("rating").isNotEmpty()) "★ ${e.optString("rating")}" else "", e.optString("runtime"), if (playing) "Playing" else "").filter { it.isNotEmpty() }.joinToString(" · ")
            if (facts.isNotEmpty()) texts.addView(text(12f, MUTED).apply {
                text = facts
                setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xCC101010.toInt(), MUTED)))
                isDuplicateParentStateEnabled = true
            })
            row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
            row.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4) }
            add(row, playing)
        }
    }

    // ---------- Browse: this show's episodes, suggestions and search, in one place ----------
    // Everyone can look around; only hosts can change what plays (guests are told so).
    private val canChange get() = !isGuest
    private val uiScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
    private fun denyChange() = toastBar("Only the host can change what plays")
    private var suggestions: List<JSONObject>? = null
    private var suggestLoading = false
    private var searchResults: List<JSONObject>? = null
    private var searchDraft = ""
    private var searchBusy = false
    private var searchInput: EditText? = null

    private fun renderBrowse() {
        panelTitle.text = "Browse"
        if (!canChange) add(note("Only the host can change what plays. You can look around."))
        val current = info.optString("current")
        if (current.isNotEmpty()) {
            val show = info.optString("show")
            add(row("Other streams", if (show.isNotEmpty()) "Another source for this episode, from where you are" else "Another source for this movie, from where you are") {
                if (!canChange) { denyChange(); return@row }
                // Home opens the title that's playing at its streams; the one picked starts here.
                val type = info.optString("ctype").ifEmpty { if (show.isNotEmpty()) "series" else "movie" }
                PlayerActivity.pendingTitle = JSONObject().put("id", show.ifEmpty { current }).put("type", type)
                    .put("name", info.optString("showName").ifEmpty { info.optString("title") }).toString()
                PlayerActivity.pendingStreams = true
                PlayerActivity.pendingStreamsEpisode = if (show.isNotEmpty()) current else ""
                PlayerActivity.pendingStreamsAt = activity.positionSec()
                closePanel()
                activity.changeVideo()
            }.also { it.tag = "otherstreams" })
        }
        if ((info.optJSONArray("episodes")?.length() ?: 0) > 0) add(row("This show", "Episodes and seasons") { openPanel("episodes") })
        add(row("Suggested for you", "Trending, from your Home rows") { openPanel("suggest") })
        add(row("Search", "Find another movie or show") { openPanel("search") })
    }

    /** A title in a list: its poster, name and year. Pressing it (hosts only) goes to that title's streams, and plays for everyone. */
    private fun titleRow(m: JSONObject, rowTag: String): View {
        val r = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = focusBackground(radius = 12, idle = Color.TRANSPARENT, focused = Color.WHITE)
            isFocusable = true
            isClickable = true
            tag = rowTag
            setOnClickListener {
                if (!canChange) { denyChange(); return@setOnClickListener }
                PlayerActivity.pendingTitle = m.toString()
                closePanel()
                activity.changeVideo()
            }
        }
        val thumb = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(0xFF25201D.toInt())
            val u = m.optString("poster").replace("/w342/", "/w185/")
            tag = u
            loadThumb(u, this)
        }
        r.addView(thumb, LinearLayout.LayoutParams(dp(54), dp(81)).apply { rightMargin = dp(14) })
        val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; isDuplicateParentStateEnabled = true }
        texts.addView(text(16f, Color.WHITE, bold = true).apply { text = m.optString("name"); maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setTextColor(focusText()); isDuplicateParentStateEnabled = true })
        val facts = listOf(if (m.optString("type") == "series") "Series" else "Movie", m.optString("releaseInfo"), if (m.optString("imdbRating").isNotEmpty()) "★ ${m.optString("imdbRating")}" else "").filter { it.isNotEmpty() }.joinToString(" · ")
        texts.addView(text(13f, MUTED).apply { text = facts; setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(0xCC101010.toInt(), MUTED))); isDuplicateParentStateEnabled = true })
        r.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
        r.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4) }
        return r
    }

    private fun renderSuggest() {
        panelTitle.text = "Suggested"
        val have = suggestions
        if (have == null) {
            add(note("Finding something good…"))
            if (!suggestLoading) {
                suggestLoading = true
                uiScope.launch { suggestions = loadSuggestions(); suggestLoading = false; if (panelKind == "suggest") { renderPanel(); focusPanel() } }
            }
            return
        }
        if (have.isEmpty()) { add(note("Nothing to suggest right now.")); return }
        if (!canChange) add(note("Only the host can change what plays."))
        have.forEachIndexed { i, m -> add(titleRow(m, "s:$i")) }
    }

    /** The first rows of Home (trending and the like), as the same lists Home shows. */
    private suspend fun loadSuggestions(): List<JSONObject> = try {
        val rows = (Engine.call("rows") as? JSONArray).objects().take(3)
        val out = LinkedHashMap<String, JSONObject>()
        for (r in rows) {
            val o = Engine.call("getJson", JSONObject().put("url", r.str("url")), 25_000) as? JSONObject ?: continue
            o.optJSONArray("metas").objects().forEach { m ->
                if (m.str("id").isNotEmpty() && m.str("poster").isNotEmpty()) { if (m.optString("type").isEmpty()) m.put("type", r.str("type")); out.putIfAbsent(m.str("id"), m) }
            }
            if (out.size >= 24) break
        }
        out.values.take(24)
    } catch (_: Exception) { emptyList() }

    private fun renderSearch() {
        panelTitle.text = "Search"
        if (!canChange) add(note("Only the host can change what plays."))
        val input = EditText(activity).apply {
            hint = "Movies and shows"
            setHintTextColor(MUTED)
            setTextColor(Color.WHITE)
            textSize = 18f
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            background = focusBackground(radius = 12, idle = 0x33FFFFFF, focused = 0x55FFFFFF)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setText(searchDraft); setSelection(text.length)
            setOnEditorActionListener { v, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) { runSearch(v.text.toString().trim()); true } else false
            }
            setOnClickListener { (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, 0) }
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) { searchDraft = e?.toString().orEmpty() }
                override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            })
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        }
        searchInput = input
        add(input)
        val res = searchResults
        when {
            searchBusy -> add(note("Searching…"))
            res == null -> add(note("Type a name, then press the search key."))
            res.isEmpty() -> add(note("Nothing found. Try other words."))
            else -> res.forEachIndexed { i, m -> add(titleRow(m, "sr:$i")) }
        }
    }

    private fun runSearch(q: String) {
        if (q.length < 2) return
        searchBusy = true
        renderPanel()
        uiScope.launch {
            searchResults = try {
                (Engine.call("search", JSONObject().put("q", q)) as? JSONArray).objects().filter { it.str("poster").isNotEmpty() && it.str("id").isNotEmpty() }.distinctBy { it.str("id") }.take(20)
            } catch (_: Exception) { emptyList() }
            searchBusy = false
            if (panelKind == "search") { renderPanel(); (panelList.findViewWithTag<View>("sr:0") ?: searchInput)?.requestFocus() }
        }
    }

    fun showToast(msg: String) { if (!barVisible) showBar(); toastBar(msg) }

    /** "Sam joined" / "Sam left": a short line for five seconds, without bringing up the controls. */
    fun presence(msg: String) {
        (chatStack.layoutParams as FrameLayout.LayoutParams).gravity = (if (panelVisible) Gravity.START else Gravity.END) or Gravity.TOP
        chatStack.requestLayout()
        val line = TextView(activity).apply {
            text = msg
            textSize = 15f
            setTextColor(Color.WHITE)
            setPadding(dp(14), dp(9), dp(14), dp(9))
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(0xB3000000.toInt()) }
            alpha = 0f
        }
        chatStack.addView(line, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        while (chatStack.childCount > 4) chatStack.removeViewAt(0)
        line.animate().alpha(1f).setDuration(200).start()
        handler.postDelayed({ line.animate().alpha(0f).setDuration(400).withEndAction { chatStack.removeView(line) }.start() }, 5000)
    }

    // ---------- from the page ----------
    private var sharedSubtitleRevision = ""
    private fun selectSharedEmbedded() {
        if (activity.subtitlePersonal && !info.optBoolean("isSettingsOwner")) return
        val embedded = info.optJSONObject("roomSubtitle")?.optJSONObject("state")?.optString("embeddedLang").orEmpty()
        if (embedded.isEmpty()) return
        val p = playerOf() ?: return
        val match = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
            .flatMap { g -> (0 until g.length).map { i -> g to i } }
            .firstOrNull { (g, i) -> sameLang(g.getTrackFormat(i).language ?: "", embedded) } ?: return
        if (match.first.isTrackSelected(match.second) && !p.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setOverrideForType(TrackSelectionOverride(match.first.mediaTrackGroup, match.second)).build()
    }
    fun setInfo(o: JSONObject) {
        val hadSubs = (info.optJSONArray("subs")?.length() ?: 0) > 0
        var subtitleChanged = false
        info = o
        o.optJSONObject("roomSubtitle")?.let { shared ->
            val revision = "${shared.optString("mediaId")}:${shared.optLong("revision") }"
            if (revision != sharedSubtitleRevision && (!activity.subtitlePersonal || o.optBoolean("isSettingsOwner"))) {
                subtitleChanged = true
                sharedSubtitleRevision = revision
                shared.optJSONObject("state")?.let { state ->
                    activity.applySharedSubtitle(state, shared.optBoolean("own"))
                    externalUrl = if (state.isNull("vtt")) "" else state.optString("key")
                    subPref = state.optString("lang", "off")
                    selectSharedEmbedded()
                }
            }
        }
        if (o.has("subPref") && (!o.has("roomSubtitle") || activity.subtitlePersonal)) subPref = o.optString("subPref")
        autoPickAudio()
        reportStartingAudio()
        reportStartingSubtitle()
        if (barVisible) updateMeta() else updateBehindPill()
        if (panelVisible && (panelKind == "people" || panelKind == "invite" || (panelKind == "subs" && (!hadSubs || subtitleChanged)))) {
            renderPanel(); focusPanel()
        }
        if (!hadSubs && (o.optJSONArray("subs")?.length() ?: 0) > 0) autoPickPreferred()
    }

    fun reset(titleText: String) {
        inviteDevices = null
        invitedIds.clear()
        title.text = titleText
        title.visibility = if (titleText.isEmpty()) View.GONE else View.VISIBLE
        info = JSONObject()
        externalUrl = ""
        subsLang = ""
        restoreDone = false
        sharedSubtitleRevision = ""
        audioAuto = false
        audioPersonal = false
        reportedAudio = ""
        reportedStartingSubtitle = false
        autoSyncing = false
        autoSyncLine = ""
        panel.visibility = View.GONE
        panelKind = ""
        bar.visibility = View.GONE
    }

    fun release() { handler.removeCallbacksAndMessages(null); scrubThumbs?.close(); scrubThumbs = null }
}
