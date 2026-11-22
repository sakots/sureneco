package sureneco.sakots.phptrial

import android.Manifest
import android.app.Activity
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
        selection = retained ?: SelectionSession(app.state)
        val ui = TrialWidgets(this)
        val card = ui.card("端末の通知")
        fun text(value: String, size: Float = 13f) = ui.label(value, size, ui.muted).also {
            ui.add(card, it, 6)
        }
        fun button(label: String, primary: Boolean = false, action: () -> Unit) =
            ui.button(label, primary = primary, action = action).also { ui.add(card, it, 8) }
        text("PHP・FCM試験版は本体と別のアプリです。通知には試験サーバーの送信先登録が必要です。")
        text("Firebase プロジェクト: ${BuildConfig.FCM_PROJECT_ID}\nパッケージ: $packageName", 12f)
        text("開始すると Google / Firebase に端末の登録情報を送信します。登録トークンは機密情報として端末に保存し、監視サーバーへの照合にはトークンそのものではなく照合用の証明値を送信します。")
        consent = CheckBox(this).apply {
            text = "上記に同意し、この端末で接続試験の通知を受け取ります"
            setTextColor(ui.text)
            isChecked = savedInstanceState?.getBoolean("consent") ?: app.state.snapshot().enabled
        }
        ui.add(card, consent, 8)
        startButton = button("同意して通知試験を開始", primary = true) { requestStart() }
        retryButton = button("登録トークンを再取得") {
            if (checkRegistrationRequirements() && app.state.snapshot().enabled) fetchToken()
        }
        stopButton = button("試験を停止・保存トークンを消去") { stopTrial(true) }
        status = text("")
        tokenStatus = text("")
        copyButton = button("登録トークンを機密クリップボードにコピー") { copyToken() }
        text("コピーした完全なトークンは、信頼できる送信担当者にだけ渡してください。他のアプリへの貼り付け・クリップボード同期に注意し、使用後は消去してください。画面には末尾だけ表示します。")
        button("Android の通知設定を開く") { openNotificationSettings() }
        feedback = text(savedInstanceState?.getString("notificationFeedback").orEmpty()).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        ui.add(card, ui.heading("端末の最終受信", 15f), 14)
        receipt = text("")
        text("FCM の送信受理だけでは端末の受信成功になりません。eventId と受信記録を照合してください。接続試験の有効期限は300秒、募集通知は募集期限までの最大300秒です。端末時計を正しく設定してください。停止後も既存の FCM 登録自体は残りますが、このアプリは受信通知を表示しません。")
        if (!app.firebaseReady) feedback.text = "Firebase の初期化に失敗しました。試験用のクライアント設定で APK を作り直してください。"
        dashboard = TrialDashboard(this, ui, selection, card, savedInstanceState)
        render()
    }

    override fun onResume() {
        super.onResume()
        app.state.observe(stateListener)
        if (app.state.snapshot().enabled && !TrialNotifications.allowed(this)) {
            stopTrial(false)
            feedback.text = "通知が許可されていないため試験を停止しました。Android の設定を確認し、再度同意して開始してください。"
        }
        selection.onChanged = ::renderSelection
        selection.refresh()
        renderSelection()
        handler.postDelayed(refreshTick, 60_000L)
        render()
    }

    override fun onPause() {
        selection.onChanged = null
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
        status.text = "試験状態: ${if (state.enabled) "実行中" else "停止中"}\n通知許可: ${if (TrialNotifications.allowed(this)) "許可済み" else "未許可・無効"}\n登録状態: ${state.registration}"
        tokenStatus.text = if (state.token.isEmpty()) "現在の登録トークン: なし" else "現在の登録トークン: …${state.token.takeLast(8)}（全体は非表示）"
        receipt.text = state.receipt
        startButton.isEnabled = !state.enabled && app.firebaseReady
        retryButton.isEnabled = state.enabled && app.firebaseReady
        stopButton.isEnabled = state.enabled || state.token.isNotEmpty()
        copyButton.isEnabled = state.enabled && state.token.isNotEmpty()
        consent.isEnabled = !state.enabled
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
            feedback.text = "Firebase の初期化に失敗しています。試験用の設定を確認してください。"
            return false
        }
        if (GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(this) != ConnectionResult.SUCCESS) {
            feedback.text = "Google Play 開発者サービスが利用できません。Google Play 対応端末で有効化・更新してから再試行してください。"
            return false
        }
        if (checkPermission && !TrialNotifications.allowed(this)) {
            feedback.text = "Android の通知権限または試験チャンネルが無効です。通知設定で許可してから開始してください。"
            return false
        }
        return true
    }

    private fun beginTrial() {
        if (!consent.isChecked || !checkRegistrationRequirements()) return
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
