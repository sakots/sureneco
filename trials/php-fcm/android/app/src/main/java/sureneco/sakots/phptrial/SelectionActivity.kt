package sureneco.sakots.phptrial

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.IOException
import java.util.concurrent.Executors

class SelectionActivity : Activity() {
    private val state get() = (application as TrialApplication).state
    private lateinit var reloadButton: Button
    private lateinit var feedback: TextView
    private lateinit var threads: LinearLayout
    private var session: Session? = null
    private var busy = false

    private class Session(val registration: String, val bearer: String)
    private class Snapshot(val session: Session, val threads: List<SelectionThread>)
    private class MissingRegistration : IOException()
    private class RegistrationChanged : IOException()

    companion object {
        // A newly opened screen queues its read behind any save from the previous screen.
        private val requests = Executors.newSingleThreadExecutor()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val padding = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
            if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            if (Build.VERSION.SDK_INT >= 29) importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        }
        val scroll = ScrollView(this).apply { addView(layout) }
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(scroll)
        scroll.requestApplyInsets()

        fun label(value: String, size: Float = 16f) = TextView(this).apply {
            text = value
            textSize = size
            setPadding(0, padding / 2, 0, padding / 2)
            layout.addView(this)
        }
        fun button(value: String, action: () -> Unit) = Button(this).apply {
            text = value
            isAllCaps = false
            setOnClickListener { action() }
            layout.addView(this)
        }

        label("通知対象スレッド", 22f)
        label("常設版（oekakibbs.moe）から通知対象を読み込みます。照合用の情報を送信しますが、登録トークンそのものは送信しません。")
        reloadButton = button("スレッド一覧を再読み込み") { loadThreads() }
        feedback = label("").apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        threads = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layout.addView(this)
        }
        loadThreads()
    }

    override fun onDestroy() {
        session = null
        super.onDestroy()
    }

    private fun updateControls() {
        reloadButton.isEnabled = !busy
        for (index in 0 until threads.childCount) threads.getChildAt(index).isEnabled = !busy
    }

    private fun currentRegistration(): String {
        val current = state.snapshot()
        if (!current.enabled || current.token.isBlank()) throw MissingRegistration()
        return current.token
    }

    private fun requireCurrentRegistration(registration: String) {
        if (currentRegistration() != registration) throw RegistrationChanged()
    }

    private fun exchangeAndLoad(): Snapshot {
        val registration = currentRegistration()
        val bearer = SelectionClient.exchange(registration)
        requireCurrentRegistration(registration)
        return Snapshot(Session(registration, bearer), SelectionClient.load(bearer))
    }

    private fun loadThreads() {
        if (busy) return
        threads.removeAllViews()
        runRequest("スレッド一覧を読み込み中…", "一覧を取得できませんでした。", {
            exchangeAndLoad()
        }) { snapshot ->
            showSnapshot(snapshot, if (snapshot.threads.isEmpty()) "選択できるスレッドはありません。" else "スレッド一覧を読み込みました。")
        }
    }

    private fun showSnapshot(snapshot: Snapshot, message: String) {
        requireCurrentRegistration(snapshot.session.registration)
        threads.removeAllViews()
        session = snapshot.session
        for (thread in snapshot.threads) {
            threads.addView(CheckBox(this).apply {
                text = thread.title
                isChecked = thread.enabled
                setOnClickListener {
                    val requested = isChecked
                    isChecked = thread.enabled
                    saveToggle(thread.id, requested)
                }
            })
        }
        feedback.text = message
    }

    private fun saveToggle(id: String, enabled: Boolean) {
        if (busy) return
        val previous = session ?: return
        runRequest("通知対象を保存中…", "保存結果を確認できませんでした。", {
            requireCurrentRegistration(previous.registration)
            try {
                Snapshot(previous, SelectionClient.save(previous.bearer, id, enabled)) to true
            } catch (error: SelectionHttpError) {
                if (error.status != 401) throw error
                // Refresh credentials and read current state; never replay the write.
                exchangeAndLoad() to false
            }
        }) { (snapshot, saved) ->
            showSnapshot(snapshot, if (saved) "サーバーで通知対象の保存を確認しました。"
                else "選択の認証が切れたため保存できませんでした。一覧を更新したので、必要なら操作をやり直してください。")
        }
    }

    private fun <T> runRequest(pending: String, failure: String, work: () -> T, success: (T) -> Unit) {
        session = null
        busy = true
        feedback.text = pending
        updateControls()
        requests.execute {
            val result = try {
                Result.success(work())
            } catch (e: Exception) {
                Result.failure(e)
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                busy = false
                val error = result.fold({ value ->
                    try {
                        success(value)
                        null
                    } catch (error: IOException) {
                        error
                    }
                }, { it })
                if (error != null) {
                    threads.removeAllViews()
                    feedback.text = when (error) {
                        is MissingRegistration -> "この端末は未登録です。試験画面で試験を開始するか、「登録トークンを再取得」を実行してから再読み込みしてください。"
                        is RegistrationChanged -> "端末の登録トークンが変わりました。サーバーの通知先を最新の登録に更新し、一覧を再読み込みしてください。"
                        is SelectionHttpError -> when (error.status) {
                            401, 403 -> "$failure サーバーの通知先がこの端末の現在の登録トークンと一致していることを確認し、再読み込みしてください。"
                            409, 503 -> "$failure 時間をおいて一覧を再読み込みし、必要なら操作をやり直してください。"
                            else -> "$failure 一覧を再読み込みしてください。"
                        }
                        else -> "$failure 一覧を再読み込みしてください。"
                    }
                }
                updateControls()
            }
        }
    }
}
