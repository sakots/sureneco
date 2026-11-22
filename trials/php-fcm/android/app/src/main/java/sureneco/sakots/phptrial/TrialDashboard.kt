package sureneco.sakots.phptrial

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal class TrialDashboard(
    private val activity: Activity,
    private val ui: TrialWidgets,
    private val session: SelectionSession,
    notificationSettings: View,
    restored: Bundle?,
) {
    private enum class Page(val label: String) { THREADS("スレッド"), RECRUITMENTS("友人戦募集"), SETTINGS("設定") }
    private class Tab(val view: LinearLayout, val label: TextView, val count: TextView?, val indicator: View)
    private class Availability(val root: LinearLayout, val title: TextView, val help: TextView, val settings: View)
    private class RecruitmentCard(val expiresAt: Long, val root: View, val badge: TextView, var active: Boolean? = null)
    private data class SettingsDraft(val seconds: String, val filter: String)

    private val root = ui.column().apply { setPadding(ui.dp(14), ui.dp(10), ui.dp(14), 0) }
    private val scroll = ScrollView(activity).apply { isFillViewport = true }
    private val pages = List(Page.entries.size) { ui.column().apply { setPadding(0, 0, 0, ui.dp(14)) } }
    private var page = Page.entries.getOrElse(restored?.getInt("dashboard.page") ?: 0) { Page.THREADS }
    private val positions = restored?.getIntArray("dashboard.scroll")?.takeIf { it.size == pages.size } ?: IntArray(pages.size)
    private var pendingScroll: Int? = positions[page.ordinal]
    private var restoringScroll = false
    private var draftOnRestore = restored?.let { bundle ->
        val interval = bundle.getString("dashboard.interval")
        val filter = bundle.getString("dashboard.filter")
        if (interval != null && filter != null) SettingsDraft(interval, filter) else null
    }

    private val statusText = ui.label(size = 12f, color = ui.muted)
    private val statusDot = View(activity).apply {
        background = ui.shape(ui.muted, 10)
        backgroundTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_activated), intArrayOf()),
            intArrayOf(ui.accent, ui.muted),
        )
    }
    private val tabs = Page.entries.map(::tab)
    private val noticeText = ui.label(size = 13f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
    private val threadReload = reloadButton()
    private val recruitmentReload = reloadButton()
    private val settingsReload = reloadButton()
    private val threads = ui.column()
    private val recruitments = ui.column()
    private val threadAvailability = availability()
    private val recruitmentAvailability = availability()
    private val recruitmentTotal = ui.badge("募集中 —", emphasized = true)
    private val switches = mutableListOf<Switch>()
    private val recruitmentCards = mutableListOf<RecruitmentCard>()
    private val date = SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.JAPAN)
    private val jst = SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.JAPAN).apply { timeZone = TimeZone.getTimeZone("Asia/Tokyo") }
    private var lastActiveCount: Int? = null
    private var displayed: MonitoringSnapshot? = null
    private var displayedNotice: SelectionSession.Notice? = null

    private val form = ui.column().apply { visibility = View.GONE }
    private val seconds = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_NUMBER
        filters = arrayOf(InputFilter.LengthFilter(5))
        setSingleLine(true)
        setTextColor(ui.text)
        textSize = 16f
        id = View.generateViewId()
        isSaveEnabled = false // The draft is restored with its filter and server baseline.
        minHeight = ui.dp(48)
        setPadding(ui.dp(12), 0, ui.dp(12), 0)
        background = ui.shape(ui.bg, 8, ui.border)
        onFocusChangeListener = View.OnFocusChangeListener { view, focused ->
            view.background = ui.shape(ui.bg, 8, if (focused) ui.focus else ui.border)
        }
    }
    private val filterLabels = arrayOf("通常", "緩め（誤通知が増えるかもしれません）")
    private var filterIndex = 0
    private val filter = ui.button(filterLabels[0]) { chooseFilter() }
    private val save = ui.button("設定を保存", primary = true) { saveSettings() }
    private val settingsStatus = ui.label(size = 13f, color = ui.muted)

    init {
        buildHeader()
        ui.add(root, noticeText, 10)
        ui.add(pages[Page.THREADS.ordinal], section("雀魂スレッド", "通知を受け取りたいスレッドを選んでください。", threadReload), 12)
        ui.add(pages[Page.THREADS.ordinal], threads, 12)
        ui.add(pages[Page.THREADS.ordinal], threadAvailability.root)
        ui.add(pages[Page.RECRUITMENTS.ordinal], section("友人戦募集", "監視開始後に見つかった募集を表示します。", recruitmentReload), 12)
        val totalRow = ui.row().apply { addView(recruitmentTotal) }
        ui.add(pages[Page.RECRUITMENTS.ordinal], totalRow, 8)
        ui.add(pages[Page.RECRUITMENTS.ordinal], recruitments, 8)
        ui.add(pages[Page.RECRUITMENTS.ordinal], recruitmentAvailability.root)
        buildSettings(notificationSettings)

        scroll.addView(FrameLayout(activity).apply {
            pages.forEach { addView(it, FrameLayout.LayoutParams(-1, -2)) }
        })
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        ui.install(root)
        showPage()
        render()
    }

    private fun buildHeader() {
        val header = if (ui.wide) ui.row() else ui.column()
        val brand = ui.row().apply {
            addView(ui.label("猫", 20f, ui.onAccent).apply {
                gravity = Gravity.CENTER
                background = ui.shape(ui.accent, 10)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(ui.dp(36), ui.dp(36)))
            addView(ui.column().apply {
                ui.add(this, ui.heading("スレネコチェッカー", 22f))
                ui.add(this, ui.label("友人戦するにゃ！", 12f, ui.muted))
            }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = ui.dp(10) })
        }
        val status = ui.row().apply {
            addView(statusDot, LinearLayout.LayoutParams(ui.dp(7), ui.dp(7)).apply { marginEnd = ui.dp(8) })
            addView(statusText)
        }
        if (ui.wide) {
            header.addView(brand, LinearLayout.LayoutParams(0, -2, 1f))
            header.addView(status)
        } else {
            ui.add(header, brand)
            ui.add(header, status, 5)
        }
        ui.add(root, header)
        val navigation = ui.row().apply {
            gravity = Gravity.NO_GRAVITY
            tabs.forEach { addView(it.view, LinearLayout.LayoutParams(0, -1, 1f)) }
        }
        ui.add(root, navigation, 5)
        root.addView(ui.divider())
    }

    private fun tab(target: Page): Tab {
        val label = ui.label(target.label, 14f).apply { gravity = Gravity.CENTER }
        val count = if (target == Page.SETTINGS) null else ui.badge("—", true)
        val indicator = View(activity)
        val items = ui.row().apply {
            if (activity.resources.configuration.screenWidthDp < 370 || activity.resources.configuration.fontScale > 1.2f) {
                orientation = LinearLayout.VERTICAL
            }
            gravity = Gravity.CENTER
            minimumHeight = ui.dp(48)
            setPadding(ui.dp(3), ui.dp(4), ui.dp(3), ui.dp(4))
            addView(label)
            count?.let { addView(it, LinearLayout.LayoutParams(-2, -2).apply {
                if (orientation == LinearLayout.HORIZONTAL) marginStart = ui.dp(5)
            }) }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        val container = ui.column().apply {
            addView(items, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(indicator, LinearLayout.LayoutParams(-1, ui.dp(3)))
            isFocusable = true
            background = selectableBackground()
            setOnClickListener { select(target) }
            accessibilityDelegate = object : View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = Button::class.java.name
                }
            }
        }
        return Tab(container, label, count, indicator)
    }

    private fun selectableBackground() = android.util.TypedValue().let { value ->
        activity.theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true)
        activity.getDrawable(value.resourceId)
    }

    private fun section(title: String, help: String, action: View? = null): LinearLayout {
        val titleBlock = ui.column().apply {
            ui.add(this, ui.heading(title))
            ui.add(this, ui.label(help, 13f, ui.muted), 2)
        }
        return if (action != null && ui.wide) ui.row().apply {
            addView(titleBlock, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = ui.dp(12) })
            addView(action)
        } else ui.column().apply {
            ui.add(this, titleBlock)
            if (action != null) addView(action, LinearLayout.LayoutParams(-2, -2).apply { topMargin = ui.dp(8) })
        }
    }

    private fun reloadButton() = ui.button("今すぐ更新") { session.refresh(force = true) }

    private fun availability(): Availability {
        val title = ui.label(size = 16f, bold = true).apply { gravity = Gravity.CENTER }
        val help = ui.label(size = 13f, color = ui.muted).apply { gravity = Gravity.CENTER }
        val link = ui.button("設定を開く") { select(Page.SETTINGS) }
        val box = ui.column().apply {
            gravity = Gravity.CENTER_HORIZONTAL
            background = ui.shape(ui.panel, 12, ui.border, dashed = true)
            setPadding(ui.dp(16), ui.dp(24), ui.dp(16), ui.dp(24))
            ui.add(this, title)
            ui.add(this, help, 4)
            addView(link, LinearLayout.LayoutParams(-2, -2).apply { topMargin = ui.dp(10) })
        }
        return Availability(box, title, help, link)
    }

    private fun showAvailability(view: Availability, hasRows: Boolean, title: String, help: String) {
        view.root.visibility = if (hasRows || session.busy && session.snapshot == null && session.registered) View.GONE else View.VISIBLE
        if (view.root.visibility != View.VISIBLE) return
        view.settings.visibility = if (session.registered) View.GONE else View.VISIBLE
        view.title.text = when {
            !session.registered -> "端末の通知登録が必要です"
            session.snapshot == null -> "サーバーに接続できません"
            else -> title
        }
        view.help.text = when {
            !session.registered -> "設定で通知試験を開始するか、登録トークンを再取得してください。"
            session.snapshot == null -> "接続や登録状態を確認し、「今すぐ更新」をお試しください。"
            else -> help
        }
    }

    private fun buildSettings(notificationSettings: View) {
        val page = pages[Page.SETTINGS.ordinal]
        ui.add(page, section("設定", "サーバーの監視と、この端末の通知を設定します。"), 12)
        val monitoring = ui.card("サーバーの監視")
        ui.add(page, monitoring, 12)
        ui.add(monitoring, settingsStatus, 4)
        ui.add(monitoring, form)
        ui.add(form, ui.label("スレッド一覧の更新間隔（秒）", 13f, bold = true).apply { labelFor = seconds.id }, 8)
        ui.add(form, seconds, 4)
        ui.add(form, ui.label("60〜86,400 秒。サーバーがスレッド候補を確認する間隔です。", 12f, ui.muted), 4)
        filter.id = View.generateViewId()
        ui.add(form, ui.label("募集フィルタ", 13f, bold = true).apply { labelFor = filter.id }, 12)
        ui.add(form, filter, 4)
        ui.add(form, save, 12)
        ui.add(monitoring, settingsReload, 8)
        ui.add(page, notificationSettings, 12)
    }

    private fun chooseFilter() {
        AlertDialog.Builder(activity).setTitle("募集フィルタ")
            .setSingleChoiceItems(filterLabels, filterIndex) { dialog, choice ->
                filterIndex = choice
                filter.text = filterLabels[choice]
                dialog.dismiss()
            }
            .setNegativeButton("キャンセル", null).show()
    }

    private fun saveSettings() {
        val refresh = seconds.text.toString().toIntOrNull()
        if (refresh == null || refresh !in MonitoringSettings.refreshRange) {
            seconds.error = "60〜86,400 秒の整数を入力してください。"
            seconds.requestFocus()
            return
        }
        activity.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(seconds.windowToken, 0)
        session.saveSettings(MonitoringSettings(refresh, MonitoringSettings.filters[filterIndex]))
    }

    private fun draft() = SettingsDraft(seconds.text.toString(), MonitoringSettings.filters[filterIndex])

    private fun renderSettings(settings: MonitoringSettings?, previous: MonitoringSettings?) {
        form.visibility = if (settings == null) View.GONE else View.VISIBLE
        if (settings == null) {
            if (previous != null) draftOnRestore = null
            return
        }
        val local = draftOnRestore ?: previous?.let { draft() }
        draftOnRestore = null
        val next = if (local != null && !local.matches(previous) && !local.matches(settings)) {
            local
        } else {
            SettingsDraft(settings.threadRefreshSec.toString(), settings.filter)
        }
        if (seconds.text.toString() != next.seconds) seconds.setText(next.seconds)
        filterIndex = MonitoringSettings.filters.indexOf(next.filter).coerceAtLeast(0)
        filter.text = filterLabels[filterIndex]
    }

    private fun SettingsDraft.matches(settings: MonitoringSettings?): Boolean =
        settings != null && seconds.toIntOrNull() == settings.threadRefreshSec && filter == settings.filter

    fun render() {
        val snapshot = session.snapshot
        val previous = displayed
        if (snapshot?.threads != previous?.threads) renderThreads(snapshot?.threads)
        if (snapshot?.recruitments != previous?.recruitments || snapshot?.threads != previous?.threads) renderRecruitments(snapshot)
        if (snapshot?.settings != previous?.settings) renderSettings(snapshot?.settings, previous?.settings)
        displayed = snapshot
        val enabled = snapshot?.threads?.count { it.enabled } ?: 0
        statusDot.isActivated = enabled > 0
        statusText.text = when {
            enabled > 0 -> "${enabled}スレッドを監視中"
            !session.registered -> "端末の通知登録が必要です"
            snapshot != null -> "監視するスレッドを選択"
            session.busy -> "サーバーを確認中…"
            else -> "サーバー未接続"
        }
        setTabCount(Page.THREADS, snapshot?.threads?.size)
        threadReload.isEnabled = session.registered && !session.busy
        recruitmentReload.isEnabled = threadReload.isEnabled
        settingsReload.isEnabled = threadReload.isEnabled
        settingsReload.visibility = if (session.registered) View.VISIBLE else View.GONE
        val canWrite = session.canWrite
        switches.forEach { it.isEnabled = canWrite }
        seconds.isEnabled = snapshot != null
        filter.isEnabled = snapshot != null
        save.isEnabled = canWrite
        settingsStatus.text = when {
            snapshot != null -> "スレッド候補の更新間隔と募集の検出方法を保存します。"
            !session.registered -> "下の「端末の通知」で通知試験を開始するか、登録トークンを再取得してください。"
            session.busy -> "保存済みの設定を読み込んでいます。"
            else -> "保存済みの設定が読み込めていません。"
        }
        val notice = session.notice
        if (notice != displayedNotice) {
            noticeText.visibility = if (notice == null) View.GONE else View.VISIBLE
            if (notice != null) {
                ui.message(noticeText, notice.error)
                noticeText.text = notice.text
            }
            displayedNotice = notice
        } else if (notice == null) noticeText.visibility = View.GONE
        showAvailability(threadAvailability, !snapshot?.threads.isNullOrEmpty(),
            "候補のスレッドがありません", "サーバーで候補が見つかったら、今すぐ更新で読み込めます。")
        showAvailability(recruitmentAvailability, !snapshot?.recruitments.isNullOrEmpty(),
            "まだ募集はありません", "監視中のスレッドで友人戦が見つかると、ここに表示されます。")
        restoreScroll()
    }

    private fun renderThreads(rows: List<SelectionThread>?) {
        switches.clear()
        threads.removeAllViews()
        if (rows.isNullOrEmpty()) return
        val list = ui.column().apply { background = ui.shape(ui.panel, 12, ui.border) }
        rows.forEachIndexed { index, item ->
            if (index != 0) list.addView(ui.divider())
            val row = ui.row().apply { setPadding(ui.dp(14), ui.dp(5), ui.dp(10), ui.dp(5)) }
            val title = ui.button("${item.title} ↗", link = true) { openThread(item.id) }
            row.addView(title, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = ui.dp(12) })
            row.addView(Switch(activity).apply {
                contentDescription = "${item.title}を監視"
                showText = false
                isChecked = item.enabled
                minHeight = ui.dp(48)
                minWidth = ui.dp(48)
                switchMinWidth = ui.dp(44)
                splitTrack = false
                val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
                trackTintList = ColorStateList(states, intArrayOf(ui.accent, ui.muted))
                thumbTintList = ColorStateList(states, intArrayOf(ui.onAccent, ui.panel))
                text = if (item.enabled) "オン" else "オフ"
                setTextColor(if (item.enabled) ui.accent else ui.text)
                switchPadding = ui.dp(8)
                setOnClickListener {
                    val requested = isChecked
                    isChecked = item.enabled
                    session.saveThread(item.id, requested)
                }
                switches.add(this)
            })
            ui.add(list, row)
        }
        ui.add(threads, list)
        ui.add(threads, ui.label("監視をオンにすると、以後に見つかった新しい募集をお知らせします。", 13f).apply { ui.message(this) }, 12)
    }

    private fun renderRecruitments(snapshot: MonitoringSnapshot?) {
        recruitmentCards.clear()
        recruitments.removeAllViews()
        if (snapshot == null) return
        val titles = snapshot.threads.associate { it.id to it.title }
        for (item in snapshot.recruitments) {
            val card = ui.column().apply { setPadding(ui.dp(14), ui.dp(10), ui.dp(14), ui.dp(10)) }
            val badge = ui.badge("")
            val summary = ui.row().apply {
                addView(ui.label("レス ${item.number}", bold = true), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = ui.dp(8) })
                addView(badge)
            }
            ui.add(card, summary)
            ui.add(card, ui.label("投稿：${date.format(Date(item.postedAt))}", 12f, ui.muted), 3)
            ui.add(card, ui.label("有効期限（日本時間）：${jst.format(Date(item.expiresAt))}", 12f, ui.muted), 2)
            ui.add(card, ui.label(item.body).apply { setTextIsSelectable(true) }, 8)
            addRoomCopyActions(card, item.roomIds)
            addCardAction(card, ui.button("レスを開く ↗") { openThread(item.threadId, item.number) })
            val title = titles[item.threadId] ?: "スレッド ${item.threadId}"
            ui.add(card, ui.button("$title ↗", link = true) { openThread(item.threadId) }, 2)
            ui.add(recruitments, card, if (recruitmentCards.isEmpty()) 0 else 8)
            recruitmentCards.add(RecruitmentCard(item.expiresAt, card, badge))
        }
    }

    private fun addRoomCopyActions(card: LinearLayout, roomIds: List<String>) {
        if (roomIds.isEmpty()) return
        ui.add(card, ui.label("ルームID（タップでコピー）", 12f, ui.muted), 4)
        val config = activity.resources.configuration
        val columns = if (ui.wide) 6 else if (config.screenWidthDp >= 340 && config.fontScale <= 1.3f) 3 else 2
        var row: LinearLayout? = null
        roomIds.forEachIndexed { index, id ->
            if (index % columns == 0) {
                row = ui.row().also { ui.add(card, it, 4) }
            }
            row?.addView(ui.button(id) { copyRoom(id) }.apply {
                contentDescription = "ルームID $id をコピー"
                minWidth = ui.dp(56)
            }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = ui.dp(6) })
        }
    }

    private fun addCardAction(card: LinearLayout, action: View) {
        card.addView(action, LinearLayout.LayoutParams(-2, -2).apply { topMargin = ui.dp(6) })
    }

    /** Update expiry labels without fetching or rebuilding the cards; return the next deadline. */
    fun renderExpirations(now: Long): Long? {
        var next: Long? = null
        var active = 0
        for (card in recruitmentCards) {
            val fresh = card.expiresAt > now
            if (fresh) {
                active++
                next = minOf(next ?: card.expiresAt, card.expiresAt)
            }
            if (fresh != card.active) {
                card.active = fresh
                card.badge.text = if (fresh) "募集中" else "期限切れ"
                ui.styleBadge(card.badge, fresh)
                card.root.background = ui.cardBackground(fresh)
                card.root.setPadding(ui.dp(14), ui.dp(10), ui.dp(14), ui.dp(10))
            }
        }
        val count = active.takeIf { displayed != null }
        if (count != lastActiveCount) {
            lastActiveCount = count
            recruitmentTotal.text = "募集中 ${count ?: "—"}"
            setTabCount(Page.RECRUITMENTS, count)
        }
        return next
    }

    private fun setTabCount(target: Page, value: Int?) {
        val tab = tabs[target.ordinal]
        tab.count?.text = value?.toString() ?: "—"
        tab.view.contentDescription = if (value == null) target.label else "${target.label}、${value}件"
    }

    private fun copyRoom(id: String) {
        val clipboard = activity.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("ルームID", id))
        toast("ルームID $id をコピーしました。")
    }

    private fun openThread(id: String, post: Int? = null) {
        val url = Uri.parse("https://egg.5ch.io/test/read.cgi/mj/$id/${post ?: ""}")
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            toast("リンクを開けるブラウザーがありません。")
        }
    }

    private fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()

    private fun select(target: Page) {
        if (target == page) return
        positions[page.ordinal] = pendingScroll ?: scroll.scrollY
        if (page == Page.SETTINGS) {
            activity.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(seconds.windowToken, 0)
            seconds.clearFocus()
        }
        page = target
        pendingScroll = positions[target.ordinal]
        showPage()
        restoreScroll()
        session.refresh()
    }

    private fun showPage() {
        for ((index, target) in Page.entries.withIndex()) {
            val selected = target == page
            pages[index].visibility = if (selected) View.VISIBLE else View.GONE
            tabs[index].apply {
                view.isSelected = selected
                label.setTypeface(Typeface.DEFAULT, if (selected) Typeface.BOLD else Typeface.NORMAL)
                label.setTextColor(if (selected) ui.accent else ui.muted)
                indicator.setBackgroundColor(if (selected) ui.accent else ui.bg)
            }
        }
        tabs[Page.SETTINGS.ordinal].view.contentDescription = Page.SETTINGS.label
        if (displayed == null) setTabCount(Page.RECRUITMENTS, null)
    }

    private fun restoreScroll() {
        if (pendingScroll == null || restoringScroll) return
        restoringScroll = true
        scroll.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                scroll.viewTreeObserver.removeOnPreDrawListener(this)
                restoringScroll = false
                val desired = pendingScroll ?: return true
                scroll.scrollTo(0, desired)
                if (scroll.scrollY == desired || displayed != null || page == Page.SETTINGS) pendingScroll = null
                return true
            }
        })
    }

    fun saveState(out: Bundle) {
        positions[page.ordinal] = pendingScroll ?: scroll.scrollY
        out.putInt("dashboard.page", page.ordinal)
        out.putIntArray("dashboard.scroll", positions)
        val settings = displayed?.settings ?: return
        val draft = draft()
        if (!draft.matches(settings)) {
            out.putString("dashboard.interval", draft.seconds)
            out.putString("dashboard.filter", draft.filter)
        }
    }
}
