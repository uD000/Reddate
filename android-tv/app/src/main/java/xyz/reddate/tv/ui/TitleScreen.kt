package xyz.reddate.tv.ui

import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.fillMaxHeight

import kotlinx.coroutines.launch
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onGloballyPositioned
import kotlinx.coroutines.flow.first
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text

/** A movie or show: details, seasons and episodes (cards with stills), streams, and more like it. */
@OptIn(ExperimentalComposeUiApi::class, ExperimentalTvMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun TitleScreen(model: AppModel, start: Meta, autoPlay: Boolean, episodeId: String = "", startAt: Int = 0) {
    var meta by remember(start.id) { mutableStateOf(start) }
    var season by remember(start.id) { mutableStateOf(-1) }
    var episode by remember(start.id) { mutableStateOf<Episode?>(null) }
    var streams by remember(start.id) { mutableStateOf<List<Stream>?>(null) }
    var streamError by remember(start.id) { mutableStateOf("") }
    var wantPlay by remember(start.id) { mutableStateOf(autoPlay) }
    var loaded by remember(start.id) { mutableStateOf(false) }
    var checking by remember(start.id) { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val sheetState = rememberLazyListState()
    val streamFocus = remember { FocusRequester() }
    val episodeFocus = remember { FocusRequester() }
    val seasonFocus = remember { FocusRequester() } // the chip of the season being shown
    val stMem = remember(start.id) { RowMemory() }

    LaunchedEffect(start.id) {
        meta = model.meta(start)
        loaded = true
        if (meta.isSeries) season = meta.episodes.map { it.season }.filter { it > 0 }.minOrNull() ?: meta.episodes.firstOrNull()?.season ?: 1
        // A show you're partway through opens on the season you're up to, not on season 1.
        if (meta.isSeries && episodeId.isEmpty()) {
            try { model.loadContinue().join() } catch (_: Exception) { } // the list on screen may predate your last watch
            // The same show can have an IMDb id or a TMDB id, so match on the episode you were watching.
            val ep = model.continueItems.firstNotNullOfOrNull { c -> if (c.show.isEmpty()) null else meta.episodes.firstOrNull { it.id == c.id } }
            if (ep != null) season = ep.season
        }
        // Coming from Continue watching to pick another stream: go straight to that episode's streams.
        if (meta.isSeries && episodeId.isNotEmpty()) meta.episodes.firstOrNull { it.id == episodeId }?.let { season = it.season; episode = it }
    }
    // Streams: for a movie straight away; for a show, for the episode you pick.
    val streamKey = when {
        !loaded -> null
        meta.isSeries -> episode?.id
        // IMDb id when there is one; an addon's own id (any other addon type) is used as it is.
        else -> meta.imdbId.ifEmpty { if (meta.id.startsWith("tmdb:")) "" else meta.id }
    }
    var notes by remember { mutableStateOf<List<StreamNote>>(emptyList()) }
    var credits by remember(meta.id) { mutableStateOf<Credits?>(null) }
    var why by remember(start.id, episode?.id) { mutableStateOf("") }
    LaunchedEffect(meta.id, loaded) {
        val cid = meta.imdbId.ifEmpty { meta.id }
        if (credits == null && (cid.startsWith("tt") || cid.startsWith("tmdb:"))) credits = model.credits(if (meta.isSeries) "series" else "movie", cid)
    }
    LaunchedEffect(streamKey) {
        streams = null; streamError = ""; notes = emptyList()
        val key = streamKey ?: return@LaunchedEffect
        if (key.isEmpty()) { streams = emptyList(); return@LaunchedEffect }
        checking = true
        val list = try { model.streams(meta.type, key, if (meta.isSeries) meta.id else key) } catch (e: Exception) { streamError = e.message ?: ""; emptyList() }
        notes = model.streamNotes(meta.type, key)
        if (list.isEmpty()) why = model.streamWhy(meta.type, key)
        // Slower addons answer after the list is shown: pick up their messages too.
        launch { for (wait in listOf(6_000L, 10_000L)) { kotlinx.coroutines.delay(wait); notes = model.streamNotes(meta.type, key) } }
        // Test the connection to the likely ones before showing them, so the list comes in best-first.
        if (list.isNotEmpty()) model.probe(list)
        streams = model.byLatency(list)
        checking = false
        // Then the rest, in the background; the list re-sorts by speed while the remote isn't on it.
        if (list.isNotEmpty()) launch { model.probeRest(list) }
        // Slower addons keep answering: pick up what they send for up to a minute, so nobody's streams are missed.
        launch {
            val skey = if (meta.isSeries) meta.id else key
            var known = list.size
            for (round in 0 until 20) {
                kotlinx.coroutines.delay(3000)
                val (more, pending) = model.streamsMore(meta.type, key, skey) ?: break
                if (more.size > known) {
                    known = more.size
                    streams = model.byLatency(more)
                    launch { model.probeRest(more) }
                }
                if (pending == 0) break
            }
        }
        // Picking an episode only shows its streams. Nothing starts until you press one; the stream
        // that matches what you chose before is marked "Your usual" and gets the focus.
    }
    fun label() = if (meta.isSeries && episode != null) (if (meta.id.startsWith("ytc:")) episode!!.title else "${meta.name} S${episode!!.season}E${episode!!.number}") else meta.name
    // A second OK press that lands just as the screen opens must not start playing something.
    val openedAt = remember(start.id) { System.currentTimeMillis() }
    fun justOpened() = System.currentTimeMillis() - openedAt < 800
    // The resume point belongs to the episode it came with: another episode picked here starts from the top.
    fun playNow(s: Stream) = model.playStream(s, label(), meta.type, streamKey ?: meta.id, meta.background.ifEmpty { meta.poster }, if (meta.isSeries) meta.id else "",
        startAt = if (!meta.isSeries || episode?.id == episodeId) startAt else 0)
    fun play(s: Stream) { if (justOpened()) return; playNow(s) }
    val streamBtn = remember { FocusRequester() }
    val jumpScope = androidx.compose.runtime.rememberCoroutineScope()
    // The streams page (a window over this one). Play, or pressing an episode, opens it; Back closes it.
    var sheetOpen by remember(start.id) { mutableStateOf(false) }
    // Seasons and each season's episodes, worked out once per show (a long show has about a thousand episodes).
    val bySeason = remember(meta.episodes) { meta.episodes.groupBy { it.season } }
    val seasonList = remember(bySeason) { bySeason.keys.sorted() }
    // Moving across the season chips only switches the episode row once the remote rests for a moment.
    var seasonWish by remember(start.id) { mutableStateOf(-1) }
    LaunchedEffect(seasonWish) {
        if (seasonWish < 0 || seasonWish == season) return@LaunchedEffect
        kotlinx.coroutines.delay(230)
        season = seasonWish
    }
    val cr = credits
    val cardW = ((LocalConfiguration.current.screenWidthDp - 80 - 14) / 2).dp
    val castShown = cr != null && (cr.cast.isNotEmpty() || cr.crew.isNotEmpty())
    val hasEpisodes = meta.isSeries && meta.episodes.isNotEmpty()
    // Where the streams start in the page: head, (seasons, episodes), (cast & crew), then the streams' header.
    // Past the page's top padding too, so the streams' header sits right at the top with nothing peeking above it.
    val topPadPx = with(androidx.compose.ui.platform.LocalDensity.current) { 36.dp.roundToPx() }
    val streamsIdx = 1 + (if (hasEpisodes) 2 else 0) + (if (castShown) 1 else 0)

    // Play (or Watch on Home): once the streams are in, the streams page opens on them. Nothing is chosen for the
    // viewer: which stream plays is always their call.
    LaunchedEffect(wantPlay, streams, season) {
        if (!wantPlay) return@LaunchedEffect
        if (meta.isSeries && episode == null) {
            if (season < 0) return@LaunchedEffect
            wantPlay = false
            episode = meta.episodes.firstOrNull { it.season == season } ?: return@LaunchedEffect
            sheetOpen = true
            return@LaunchedEffect
        }
        val list = streams ?: return@LaunchedEffect
        wantPlay = false
        if (list.isEmpty()) { model.say("No streams found for this. Add a stream addon in Addons."); return@LaunchedEffect }
        sheetOpen = true
    }
    // A movie's page opens on its "Choose a stream" button. Shows open on their first episode (below).
    LaunchedEffect(loaded) {
        if (loaded && !meta.isSeries && !wantPlay) { kotlinx.coroutines.delay(200); try { streamBtn.requestFocus() } catch (_: Exception) { } }
    }
    // Shows have no Play button: start on the first episode once the list is there. Once only, when the page
    // opens: moving along the seasons changes the season, and that must never pull focus down to the episodes.
    var openedOnEpisode by remember(meta.id) { mutableStateOf(false) }
    LaunchedEffect(meta.episodes.size, season >= 0) {
        if (meta.isSeries && meta.episodes.isNotEmpty() && episode == null && season >= 0 && !openedOnEpisode && !wantPlay) {
            openedOnEpisode = true
            kotlinx.coroutines.delay(150)
            try { episodeFocus.requestFocus() } catch (_: Exception) { }
        }
    }
    // Coming from Continue watching to pick another stream: straight to that episode's streams.
    LaunchedEffect(episode?.id) { if (meta.isSeries && episode != null && episodeId.isNotEmpty()) sheetOpen = true }

    Box(Modifier.fillMaxSize().background(C.paper).dpadThrottle()) {
        Img(meta.heroImage, Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().fadeLeft())
        Box(Modifier.fillMaxSize().fadeUp())
        Row(Modifier.fillMaxSize()) {
        MinimalFollow { LazyColumn(
            Modifier.weight(1f).fillMaxHeight(),
            state = listState,
            contentPadding = PaddingValues(top = 8.dp, bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            item(key = "head") {
                // The details: a big title, the facts, the story, and what you can do besides playing (that's the sheet).
                Column(Modifier.padding(start = 56.dp, end = 32.dp, top = 6.dp).widthIn(max = 680.dp)) {
                    Text(meta.name, style = MaterialTheme.typography.displayLarge.copy(fontSize = if (meta.isSeries) 42.sp else 52.sp, lineHeight = if (meta.isSeries) 44.sp else 52.sp), color = C.ink, maxLines = if (meta.isSeries) 1 else 2, overflow = TextOverflow.Ellipsis)
                    val facts = listOf(meta.facts, meta.genres.take(3).joinToString(", ")).filter { it.isNotEmpty() }.joinToString("  ·  ")
                    if (facts.isNotEmpty()) Text(facts, style = MaterialTheme.typography.bodyLarge, color = C.ink.copy(alpha = 0.85f), modifier = Modifier.padding(top = 12.dp))
                    if (meta.description.isNotEmpty()) Text(meta.description, style = if (meta.isSeries) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge, color = C.ink, maxLines = if (meta.isSeries) 2 else 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = if (meta.isSeries) 8.dp else 14.dp))
                    Row(Modifier.padding(top = if (meta.isSeries) 12.dp else 16.dp).onFocusChanged { if (it.hasFocus) jumpScope.launch { try { listState.glideTo(0) } catch (_: Exception) { } } },
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (!meta.isSeries) {
                            val n = streams?.size
                            PillButton(if (n == null) "Choose a stream" else if (n == 0) "No streams yet" else "Choose a stream · $n", { sheetOpen = true }, primary = true, icon = androidx.compose.material.icons.Icons.Default.PlayArrow, modifier = Modifier.focusRequester(streamBtn))
                        }
                        val saved = model.inMyList(meta.id)
                        PillButton(if (saved) "In My List" else "My List", { model.toggleMyList(meta) }, icon = if (saved) androidx.compose.material.icons.Icons.Default.Check else androidx.compose.material.icons.Icons.Default.Add)
                        PillButton("Watch together", { model.dialog = Dlg.Together }, icon = androidx.compose.material.icons.Icons.Default.Share)
                    }
                    if (meta.cast.isNotEmpty() && !castShown) Text("Starring ${meta.cast.take(4).joinToString(", ")}", style = MaterialTheme.typography.bodySmall, color = C.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 14.dp))
                }
            }
            if (meta.isSeries && meta.episodes.isNotEmpty()) {
                val seasons = seasonList
                // A YouTube channel: its uploads newest first, with no season chips or episode numbers.
                val channel = meta.id.startsWith("ytc:")
                if (channel) item(key = "videos-title") { SectionTitle("Videos", Modifier.padding(start = 40.dp)) }
                else item(key = "seasons") {
                    val sMem = remember(meta.id) { RowMemory() }
                    // The row opens with the current season at its start, and entering it from any side lands on that
                    // chip. Both wait for the row to really exist first (on a slow TV it isn't laid out yet at this point).
                    val sState = androidx.compose.foundation.lazy.rememberLazyListState()
                    var chipReady by remember(meta.id) { mutableStateOf(false) }
                    // Only when the page opens (on the season you're up to): afterwards the row moves freely with the remote.
                    var placed by remember(meta.id) { mutableStateOf(false) }
                    LaunchedEffect(season >= 0, seasons) {
                        if (placed || season < 0) return@LaunchedEffect
                        placed = true
                        val i = seasons.indexOf(season)
                        if (i <= 0) return@LaunchedEffect
                        androidx.compose.runtime.snapshotFlow { sState.layoutInfo.visibleItemsInfo.size }.first { it > 0 }
                        try { sState.scrollToItem(i) } catch (_: Exception) { }
                        kotlinx.coroutines.delay(120)
                        try { sState.scrollToItem(i) } catch (_: Exception) { } // once more: sizes can settle after the first
                    }
                    HorizontalPin(pin = 0.04f) { LazyRow(
                        state = sState,
                        modifier = Modifier.restoreFocus(sMem).focusProperties { enter = { if (chipReady) seasonFocus else androidx.compose.ui.focus.FocusRequester.Default } },
                        contentPadding = PaddingValues(horizontal = 40.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        items(seasons, key = { it }) { s ->
                            val on = s == season
                            Surface(
                                onClick = { season = s },
                                // Landing on a season shows it: no OK needed (the remote just moves).
                                modifier = Modifier.onFocusChanged { if (it.isFocused && season != s) seasonWish = s }.remembered(sMem, s).then(if (on) Modifier.focusRequester(seasonFocus).onGloballyPositioned { chipReady = true } else Modifier),
                                shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
                                colors = ClickableSurfaceDefaults.colors(
                                    containerColor = if (on) C.paper3 else C.paper2, contentColor = if (on) C.ink else C.muted,
                                    focusedContainerColor = C.ink, focusedContentColor = C.paper
                                ),
                                border = ClickableSurfaceDefaults.border(border = if (on) Border(BorderStroke(2.dp, C.accent), shape = RoundedCornerShape(50)) else Border.None)
                            ) { Text(if (s == 0) "Specials" else "Season $s", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
                        }
                    } }
                }
                item(key = "episodes") {
                    val eps = bySeason[season].orEmpty()
                    val eMem = remember(meta.id, season) { RowMemory() }
                    androidx.compose.runtime.key(season) { HorizontalPin(pin = 0.04f) { LazyRow(
                        // Up from the episodes goes to this season's chip, not to whichever chip is nearest (season 1).
                        modifier = Modifier.restoreFocus(eMem).focusProperties { if (!channel) up = seasonFocus },
                        contentPadding = PaddingValues(horizontal = 40.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        itemsIndexed(eps, key = { _, e -> e.id }) { i, ep ->
                            val m = Modifier.remembered(eMem, ep.id)
                            EpisodeCard(ep, selected = episode?.id == ep.id, modifier = if (i == 0) m.focusRequester(episodeFocus) else m, video = channel) { episode = ep; sheetOpen = true }
                        }
                    } } }
                }
            }
            // Cast & crew, like IMDb, right under the details: the streams load below it meanwhile.
            if (castShown && cr != null) item(key = "cast") {
                Column {
                    SectionTitle("Cast & crew", Modifier.padding(start = 40.dp))
                    if (cr.crew.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(start = 40.dp, end = 40.dp, bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                        cr.crew.take(3).forEach { (job, names) ->
                            Column(Modifier.weight(1f)) {
                                Text(job.uppercase(), style = MaterialTheme.typography.labelSmall, color = C.muted, maxLines = 1, softWrap = false)
                                Text(names.take(2).joinToString(", "), style = MaterialTheme.typography.bodyMedium, color = C.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    if (cr.cast.isNotEmpty()) HorizontalPin(pin = 0.04f) { LazyRow(
                        contentPadding = PaddingValues(horizontal = 40.dp),
                        horizontalArrangement = Arrangement.spacedBy(18.dp)
                    ) { items(cr.cast, key = { it.name + it.role }) { p -> PersonCard(p) { model.go(Screen.Actor(p.name, p.photo, p.role)) } } } }
                }
            }
            if (meta.similar.isNotEmpty()) item(key = "similar") {
                // Reaching this row brings all of it up (title and whole posters), never a poster cut off at the bottom.
                Column(Modifier.onFocusChanged { f ->
                    if (f.hasFocus) jumpScope.launch {
                        kotlinx.coroutines.delay(200)
                        val i = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == "similar" }?.index ?: return@launch
                        try { listState.glideTo(i) } catch (_: Exception) { }
                    }
                }) {
                    SectionTitle("More like this", Modifier.padding(start = 40.dp))
                    val simMem = remember(meta.id) { RowMemory() }
                    HorizontalPin(pin = 0.04f) { LazyRow(
                        modifier = Modifier.restoreFocus(simMem),
                        // Room above and below for a focused poster's grow and glow, so it's never cut off.
                        contentPadding = PaddingValues(horizontal = 40.dp, vertical = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp)
                    ) { items(meta.similar, key = { it.id }) { m -> PosterCard(m, onClick = { model.go(Screen.Title(m)) }, modifier = Modifier.remembered(simMem, m.id)) } } }
                }
            }
            item { Spacer(Modifier.height(1.dp)) }
        } }
        }
        if (sheetOpen) StreamSheet(
            model, if (meta.isSeries && episode != null && !meta.id.startsWith("ytc:")) "S${episode!!.season} · E${episode!!.number}  ${episode!!.title}" else if (meta.id.startsWith("ytc:")) (episode?.title ?: meta.name) else meta.name,
            streams, notes, why, streamError, checking,
            onPlay = { st -> sheetOpen = false; play(st) }, onClose = { sheetOpen = false }
        )
    }
}

/** One addon in the streams filter: its logo, name and how many streams it gave. Focus selects it. */
@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
internal fun AddonChip(name: String, count: Int, logo: String, on: Boolean, selectOnFocus: Boolean = true, modifier: Modifier = Modifier, onFocus: () -> Unit) {
    Surface(
        onClick = onFocus,
        modifier = modifier.onFocusChanged { if (it.isFocused && selectOnFocus) onFocus() },
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (on) C.paper3 else C.paper2, contentColor = if (on) C.ink else C.muted,
            focusedContainerColor = C.ink, focusedContentColor = C.paper
        ),
        border = ClickableSurfaceDefaults.border(border = if (on) Border(BorderStroke(2.dp, C.accent), shape = RoundedCornerShape(50)) else Border.None)
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            if (logo.startsWith("http")) { Img(logo, Modifier.size(20.dp).clip(RoundedCornerShape(5.dp)), scale = androidx.compose.ui.layout.ContentScale.Fit); Spacer(Modifier.width(8.dp)) }
            Text(name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(8.dp))
            Text("$count", style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** An addon's own message in the stream list: its logo, what it says, and that OK shows the link. */
@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
internal fun AddonNoteChip(n: StreamNote, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.width(360.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(14.dp)),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color(0x33E8602C), contentColor = C.ink, focusedContainerColor = C.ink, focusedContentColor = C.paper),
        border = ClickableSurfaceDefaults.border(border = Border(BorderStroke(1.dp, Color(0x66E8602C)), shape = RoundedCornerShape(14.dp)))
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            if (n.logo.startsWith("http")) { Img(n.logo, Modifier.size(28.dp).clip(RoundedCornerShape(6.dp)), scale = androidx.compose.ui.layout.ContentScale.Fit); Spacer(Modifier.width(10.dp)) }
            Column {
                Text(n.title.ifEmpty { "From ${n.addon}" }, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOf(n.addon, n.text).filter { it.isNotEmpty() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The message in full with its link as a QR code: donating or joining happens on the phone. */
@Composable
fun AddonNoteDialog(model: AppModel, n: StreamNote) {
    val close = remember { FocusRequester() }
    androidx.compose.ui.window.Dialog(onDismissRequest = { model.dialog = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Row(Modifier.width(640.dp).clip(RoundedCornerShape(16.dp)).background(C.paper2).padding(28.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("From ${n.addon}".trim(), color = C.muted, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                Text(n.title, style = MaterialTheme.typography.headlineSmall, color = C.ink)
                if (n.text.isNotEmpty()) Text(n.text, color = C.muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.height(10.dp))
                if (n.link.isNotEmpty()) Text("Scan to open it on your phone. ${n.link.removePrefix("https://").removePrefix("http://").take(60)}", color = C.muted, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(18.dp))
                PillButton("Close", { model.dialog = null }, modifier = Modifier.focusRequester(close))
            }
            Spacer(Modifier.width(22.dp))
            val bmp = remember(n.link) { if (n.link.isEmpty()) null else qrBitmap(n.link, 360) }
            if (bmp != null) Box(Modifier.size(170.dp).clip(RoundedCornerShape(10.dp)).background(Color.White).padding(8.dp)) {
                androidx.compose.foundation.Image(bmp.asImageBitmap(), contentDescription = "QR code", modifier = Modifier.fillMaxSize())
            }
        }
    }
    LaunchedEffect(Unit) { kotlinx.coroutines.delay(50); try { close.requestFocus() } catch (_: Exception) { } }
}

/** One actor: a round photo (or their initials), the name and who they play. Focusable so the row scrolls. */
@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun PersonCard(p: Person, onClick: () -> Unit = {}) {
    var focused by remember { mutableStateOf(false) }
    Column(Modifier.width(112.dp), horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            modifier = Modifier.size(96.dp).onFocusChanged { focused = it.isFocused },
            shape = ClickableSurfaceDefaults.shape(androidx.compose.foundation.shape.CircleShape),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
            colors = ClickableSurfaceDefaults.colors(containerColor = C.paper3, focusedContainerColor = C.paper3),
            border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(3.dp, C.ink), shape = androidx.compose.foundation.shape.CircleShape))
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                Text(p.name.split(" ").mapNotNull { it.firstOrNull()?.uppercase() }.take(2).joinToString(""), style = MaterialTheme.typography.titleLarge, color = C.muted)
                if (p.photo.startsWith("https://")) Img(p.photo, Modifier.fillMaxSize().clip(androidx.compose.foundation.shape.CircleShape))
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(p.name, style = MaterialTheme.typography.labelLarge, color = if (focused) C.ink else C.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (p.role.isNotEmpty()) Text(p.role, style = MaterialTheme.typography.bodySmall, color = C.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}


/** While the streams load: placeholder cards that shimmer, with a short line saying what's happening. */
@Composable
internal fun StreamsLoading(what: String) {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "streamsLoading")
    val x by t.animateFloat(-1f, 2f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(1300, easing = androidx.compose.animation.core.LinearEasing)), label = "sweep")
    val dots by t.animateFloat(0f, 3.99f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(1200, easing = androidx.compose.animation.core.LinearEasing)), label = "dots")
    val cardW = ((LocalConfiguration.current.screenWidthDp - 80 - 14) / 2).dp
    Column(Modifier.padding(horizontal = 40.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(what + ".".repeat(dots.toInt()), color = C.muted, style = MaterialTheme.typography.bodyMedium)
        repeat(2) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                repeat(2) {
                    Box(
                        Modifier.width(cardW).height(150.dp).clip(RoundedCornerShape(10.dp)).background(C.paper2)
                            .drawWithContent {
                                drawContent()
                                val w = size.width
                                drawRect(androidx.compose.ui.graphics.Brush.linearGradient(
                                    listOf(androidx.compose.ui.graphics.Color(0x00FFFFFF), androidx.compose.ui.graphics.Color(0x12FFFFFF), androidx.compose.ui.graphics.Color(0x00FFFFFF)),
                                    start = androidx.compose.ui.geometry.Offset(w * x - w * 0.5f, 0f), end = androidx.compose.ui.geometry.Offset(w * x, size.height)))
                            }
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.width(150.dp).height(18.dp).clip(RoundedCornerShape(5.dp)).background(C.paper3))
                            Box(Modifier.width(100.dp).height(14.dp).clip(RoundedCornerShape(5.dp)).background(C.paper3))
                            Box(Modifier.width(260.dp).height(14.dp).clip(RoundedCornerShape(5.dp)).background(C.paper3))
                        }
                    }
                }
            }
        }
    }
}
