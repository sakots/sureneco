package sureneco.sakots.phptrial

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.TextView
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : Activity() {
    private val app get() = application as TrialApplication
    private val publicRegistration get() = app.publicRegistration
    private lateinit var selection: SelectionSession
    private lateinit var dashboard: TrialDashboard
    private val handler = Handler(Looper.getMainLooper())
    private val expiryTick = Runnable { renderExpirations() }
    private val refreshTick = object : Runnable {
        override fun run() {
            selection.refresh()
            handler.postDelayed(this, 60_000L)
        }
    }
    private lateinit var consent: CheckBox
    private lateinit var status: TextView
    private lateinit var tokenStatus: TextView
    private lateinit var receipt: TextView
    private lateinit var feedback: TextView
    private lateinit var startButton: Button
    private lateinit var retryButton: Button
    private lateinit var stopButton: Button
    private lateinit var copyButton: Button
    private var deleteButton: Button? = null
    private var wasPublicStarted = false
    private var pendingStart = false
    private val stateListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        render()
        selection.refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingStart = savedInstanceState?.getBoolean("pendingStart") ?: false
        @Suppress("DEPRECATION")
        val retained = lastNonConfigurationInstance as? SelectionSession
        selection = retained ?: SelectionSession(app.state, publicRegistration)
        val ui = TrialWidgets(this)
        val card = ui.card("端末の通知")
        fun text(value: String, size: Float = 13f) = ui.label(value, size, ui.muted).also {
            ui.add(card, it, 6)
        }
        fun button(label: String, primary: Boolean = false, action: () -> Unit) =
            ui.button(label, primary = primary, action = action).also { ui.add(card, it, 8) }
        val formal = publicRegistration != null
        if (formal) {
            text("この端末で募集通知を受け取ります。通知先を確かめるため、登録情報を Google / Firebase と監視サーバーに送信します。登録先や認証情報は画面に表示しません。")
        } else {
            text("PHP・FCM試験版は本体と別のアプリです。通知には試験サーバーの送信先登録が必要です。")
            text("Firebase プロジェクト: ${BuildConfig.FCM_PROJECT_ID}\nパッケージ: $packageName", 12f)
            text("開始すると Google / Firebase に端末の登録情報を送信します。登録トークンは機密情報として端末に保存し、監視サーバーへの照合にはトークンそのものではなく照合用の証明値を送信します。")
        }
        consent = CheckBox(this).apply {
            text = if (formal) "上記に同意し、この端末で募集通知を受け取ります" else "上記に同意し、この端末で接続試験の通知を受け取ります"
            setTextColor(ui.text)
            isChecked = savedInstanceState?.getBoolean("consent") ?: (publicRegistration?.started ?: app.state.snapshot().enabled)
        }
        ui.add(card, consent, 8)
        startButton = button(if (formal) "同意して通知を登録" else "同意して通知試験を開始", primary = true) { requestStart() }
        retryButton = button(if (formal) "登録を再試行" else "登録トークンを再取得") {
            val public = publicRegistration
            if (public == null) {
                if (checkRegistrationRequirements() && app.state.snapshot().enabled) fetchToken()
            } else if (public.pending == PublicRegistration.Action.RESUME) requestStart()
            else if (public.pending != null || checkRegistrationRequirements()) public.startOrRetry()
        }
        stopButton = button(if (formal) "サーバーの監視を停止" else "試験を停止・保存トークンを消去") {
            publicRegistration?.change(PublicRegistration.Action.PAUSE) ?: stopTrial(true)
        }
        if (formal) deleteButton = button("サーバーと端末の登録を削除") { confirmDeletion() }
        status = text("").apply { if (formal) accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        if (!formal) {
            tokenStatus = text("")
            copyButton = button("登録トークンを機密クリップボードにコピー") { copyToken() }
            text("コピーした完全なトークンは、信頼できる送信担当者にだけ渡してください。他のアプリへの貼り付け・クリップボード同期に注意し、使用後は消去してください。画面には末尾だけ表示します。")
        }
        button("Android の通知設定を開く") { openNotificationSettings() }
        feedback = text(savedInstanceState?.getString("notificationFeedback").orEmpty()).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        ui.add(card, ui.heading("端末の最終受信", 15f), 14)
        receipt = text("")
        if (formal) text("監視を停止しても選択したスレッドと設定は残ります。登録を削除するとサーバーの設定も消去されます。")
        else text("FCM の送信受理だけでは端末の受信成功になりません。eventId と受信記録を照合してください。接続試験の有効期限は300秒、募集通知は募集期限までの最大300秒です。端末時計を正しく設定してください。停止後も既存の FCM 登録自体は残りますが、このアプリは受信通知を表示しません。")
        if (!app.firebaseReady) feedback.text = if (formal) "通知サービスの初期化に失敗しました。" else "Firebase の初期化に失敗しました。試験用のクライアント設定で APK を作り直してください。"
        dashboard = TrialDashboard(this, ui, selection, card, savedInstanceState)
        render()
    }

    override fun onResume() {
        super.onResume()
        app.state.observe(stateListener)
        if (publicRegistration == null && app.state.snapshot().enabled && !TrialNotifications.allowed(this)) {
            stopTrial(false)
            feedback.text = "通知が許可されていないため試験を停止しました。Android の設定を確認し、再度同意して開始してください。"
        }
        selection.onChanged = ::renderSelection
        publicRegistration?.onChanged = {
            render()
            selection.refresh()
            renderSelection()
        }
        publicRegistration?.recover()
        selection.refresh()
        renderSelection()
        handler.postDelayed(refreshTick, 60_000L)
        render()
    }

    override fun onPause() {
        selection.onChanged = null
        publicRegistration?.onChanged = null
        handler.removeCallbacks(refreshTick)
        handler.removeCallbacks(expiryTick)
        app.state.unobserve(stateListener)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("pendingStart", pendingStart)
        outState.putBoolean("consent", consent.isChecked)
        outState.putString("notificationFeedback", feedback.text.toString())
        dashboard.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onRetainNonConfigurationInstance(): Any = selection

    private fun renderSelection() {
        dashboard.render()
        renderExpirations()
    }

    private fun renderExpirations() {
        handler.removeCallbacks(expiryTick)
        val now = System.currentTimeMillis()
        dashboard.renderExpirations(now)?.let { deadline ->
            handler.postDelayed(expiryTick, (deadline - now).coerceIn(1L, 60_000L))
        }
    }

    private fun render() {
        if (!::status.isInitialized) return
        val state = app.state.snapshot()
        publicRegistration?.let {
            renderPublic(it, state.receipt)
            return
        }
        status.text = "試験状態: ${if (state.enabled) "実行中" else "停止中"}\n通知許可: ${if (TrialNotifications.allowed(this)) "許可済み" else "未許可・無効"}\n登録状態: ${state.registration}"
        tokenStatus.text = if (state.token.isEmpty()) "現在の登録トークン: なし" else "現在の登録トークン: …${state.token.takeLast(8)}（全体は非表示）"
        receipt.text = state.receipt
        startButton.isEnabled = !state.enabled && app.firebaseReady
        retryButton.isEnabled = state.enabled && app.firebaseReady
        stopButton.isEnabled = state.enabled || state.token.isNotEmpty()
        copyButton.isEnabled = state.enabled && state.token.isNotEmpty()
        consent.isEnabled = !state.enabled
    }

    private fun renderPublic(public: PublicRegistration, lastReceipt: String) {
        val notification = if (TrialNotifications.allowed(this)) "許可済み" else "未許可・無効"
        val registration = when {
            public.pending != null -> "サーバーでの操作を確認中"
            !public.started -> "未登録"
            !public.enrolled -> "端末の確認が必要"
            !public.current -> "新しい通知先を確認中"
            public.paused -> "登録済み・監視停止中"
            else -> "登録済み"
        }
        status.text = "端末の通知許可: $notification\n登録状態: $registration" +
            public.message.takeIf { it.isNotEmpty() }?.let { "\n$it" }.orEmpty()
        receipt.text = lastReceipt
        consent.isEnabled = !public.started
        if (public.started || wasPublicStarted) consent.isChecked = public.started
        wasPublicStarted = public.started
        startButton.text = if (public.paused) "サーバーの監視を再開" else "同意して通知を登録"
        startButton.isEnabled = !public.busy && public.pending == null && (!public.started || public.paused) && app.firebaseReady
        retryButton.text = when (public.pending) {
            PublicRegistration.Action.PAUSE -> "監視停止を再試行"
            PublicRegistration.Action.RESUME -> "監視再開を再試行"
            PublicRegistration.Action.DELETE -> "登録削除を再試行"
            null -> "登録を再試行"
        }
        retryButton.isEnabled = public.started && !public.busy && !public.waiting &&
            (public.pending != null || (!public.current && app.firebaseReady))
        stopButton.isEnabled = public.enrolled && !public.paused && !public.busy && public.pending == null
        deleteButton?.isEnabled = public.started && !public.busy && public.pending != PublicRegistration.Action.DELETE
    }

    private fun confirmDeletion() {
        AlertDialog.Builder(this).setTitle("通知の登録を削除")
            .setMessage("サーバーに保存した通知対象と設定を削除します。再び利用するときは通知を新規登録してください。")
            .setNegativeButton("キャンセル", null)
            .setPositiveButton("削除") { _, _ ->
                publicRegistration?.change(PublicRegistration.Action.DELETE)
            }
            .show()
    }

    private fun requestStart() {
        if (!consent.isChecked) {
            feedback.text = "開始するには同意のチェックを入れてください。"
            return
        }
        if (!checkRegistrationRequirements(checkPermission = false)) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingStart = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 300)
            return
        }
        beginTrial()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 300 || !pendingStart) return
        pendingStart = false
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) beginTrial()
        else feedback.text = "通知権限が許可されませんでした。登録は行いません。再試行するか Android の通知設定で許可してください。"
    }

    private fun checkRegistrationRequirements(checkPermission: Boolean = true): Boolean {
        if (!app.firebaseReady) {
            feedback.text = if (publicRegistration != null) "通知サービスの初期化に失敗しています。" else "Firebase の初期化に失敗しています。試験用の設定を確認してください。"
            return false
        }
        if (GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(this) != ConnectionResult.SUCCESS) {
            feedback.text = "Google Play 開発者サービスが利用できません。Google Play 対応端末で有効化・更新してから再試行してください。"
            return false
        }
        if (checkPermission && !TrialNotifications.allowed(this)) {
            feedback.text = if (publicRegistration != null) "Android の通知が無効です。通知設定で許可してから開始してください。" else "Android の通知権限または試験チャンネルが無効です。通知設定で許可してから開始してください。"
            return false
        }
        return true
    }

    private fun beginTrial() {
        if (!consent.isChecked || !checkRegistrationRequirements()) return
        publicRegistration?.let {
            feedback.text = ""
            if (it.paused || it.pending == PublicRegistration.Action.RESUME) it.change(PublicRegistration.Action.RESUME)
            else it.startOrRetry()
            return
        }
        if (!app.state.start()) {
            feedback.text = "同意状態を保存できませんでした。端末の空き容量を確認してください。"
            return
        }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        feedback.text = "試験を開始しました。トークンの取得後、送信側で明示的に試験を実行してください。"
        fetchToken()
    }

    private fun fetchToken() {
        if (!app.state.snapshot().enabled || !checkRegistrationRequirements()) return
        feedback.text = "登録トークンを取得しています…"
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!app.state.snapshot().enabled || !TrialNotifications.allowed(this)) return@addOnCompleteListener
            val saved = if (task.isSuccessful) app.state.saveToken(task.result.orEmpty()) else false
            if (!saved) app.state.registrationFailed()
            if (!isDestroyed) {
                feedback.text = if (saved) "登録トークンを取得しました。必要な場合だけコピーしてください。" else "登録トークンを取得・保存できませんでした。通信・Google Play・Firebase 設定・空き容量を確認して再試行してください。"
                render()
            }
        }
    }

    private fun stopTrial(showFeedback: Boolean) {
        val stored = app.state.stop()
        if (app.firebaseReady) FirebaseMessaging.getInstance().isAutoInitEnabled = false
        TrialNotifications.clear(this)
        consent.isChecked = false
        if (showFeedback) feedback.text = if (stored) "試験を停止し、保存トークンを消去しました。以後の受信では通知を表示しません。" else "試験を停止しましたが保存に失敗しました。空き容量を確認し、アプリのデータを消去してください。"
        render()
    }

    private fun copyToken() {
        val state = app.state.snapshot()
        if (!state.enabled || state.token.isEmpty()) {
            feedback.text = "コピーできる登録トークンがありません。"
            return
        }
        val clip = ClipData.newPlainText("FCM 試験登録トークン（機密）", state.token)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        feedback.text = "機密情報としてコピーしました。信頼できる送信先にだけ貼り付け、使用後はクリップボードを消去してください。"
    }

    private fun openNotificationSettings() {
        val intent = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        startActivity(intent)
    }
}
