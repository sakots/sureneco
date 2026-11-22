package sureneco.sakots.phptrial

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.TextUtils
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.IOException
import java.util.concurrent.Executors

class SelectionActivity : Activity() {
    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var saveButton: Button
    private lateinit var reloadButton: Button
    private lateinit var feedback: TextView
    private lateinit var threads: LinearLayout
    private var credentials: SelectionCredentials? = null
    private var busy = false
    private var snapshotValid = false

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
            isFocusableInTouchMode = true
            if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            if (Build.VERSION.SDK_INT >= 29) importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        }
        val scroll = ScrollView(this).apply { addView(layout) }
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
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
        fun input(prompt: String, type: Int) = EditText(this).apply {
            hint = prompt
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or type
            isSaveEnabled = false
            layout.addView(this)
        }
        fun button(value: String, action: () -> Unit) = Button(this).apply {
            text = value
            isAllCaps = false
            setOnClickListener { action() }
            layout.addView(this)
        }

        label("通知対象スレッド", 22f)
        label("PHP 常設版の選択 API の HTTPS URL と、選択専用トークンを入力してください。FCM 登録トークンとは別です。")
        endpointInput = input("選択 API の HTTPS URL", InputType.TYPE_TEXT_VARIATION_URI)
        tokenInput = input("選択専用トークン（64 桁の小文字16進数）", InputType.TYPE_TEXT_VARIATION_PASSWORD)
        saveButton = button("接続設定を保存して読み込む") { saveSettings() }
        reloadButton = button("スレッド一覧を再読み込み") { loadThreads() }
        feedback = label("").apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        threads = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layout.addView(this)
        }
        val editListener = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = updateControls()
            override fun afterTextChanged(s: Editable?) = Unit
        }
        endpointInput.addTextChangedListener(editListener)
        tokenInput.addTextChangedListener(editListener)
        layout.requestFocus()

        val prefs = applicationContext.getSharedPreferences("thread_selection", MODE_PRIVATE)
        runRequest("接続設定を読み込み中…", "接続設定を読み込めませんでした。", {
            SelectionCredentials.parse(prefs.getString("endpoint", "").orEmpty(), prefs.getString("token", "").orEmpty())
        }) { saved ->
            credentials = saved
            endpointInput.setText(saved?.endpoint?.toString().orEmpty())
            tokenInput.setText(saved?.token.orEmpty())
            if (saved == null) feedback.text = "接続設定を保存すると、スレッド一覧を読み込めます。"
            else loadThreads()
        }
    }

    private fun settingsMatch(): Boolean {
        val saved = credentials ?: return false
        return endpointInput.text.toString().trim() == saved.endpoint.toString() && TextUtils.equals(tokenInput.text, saved.token)
    }

    private fun updateControls() {
        val usable = !busy && settingsMatch()
        endpointInput.isEnabled = !busy
        tokenInput.isEnabled = !busy
        saveButton.isEnabled = !busy
        reloadButton.isEnabled = usable
        for (index in 0 until threads.childCount) threads.getChildAt(index).isEnabled = usable && snapshotValid
    }

    private fun saveSettings() {
        if (busy) return
        val entered = SelectionCredentials.parse(endpointInput.text.toString(), tokenInput.text.toString())
        if (entered == null) {
            feedback.text = "HTTPS URL と、64 桁の小文字16進数のトークンを確認してください。"
            return
        }
        val prefs = applicationContext.getSharedPreferences("thread_selection", MODE_PRIVATE)
        snapshotValid = false
        threads.removeAllViews()
        runRequest("接続設定を保存中…", "接続設定を保存できませんでした。", {
            if (!prefs.edit().putString("endpoint", entered.endpoint.toString()).putString("token", entered.token).commit()) {
                throw IOException()
            }
        }) {
            credentials = entered
            loadThreads()
        }
    }

    private fun loadThreads() {
        val saved = credentials ?: return
        if (busy || !settingsMatch()) return
        snapshotValid = false
        threads.removeAllViews()
        runRequest("スレッド一覧を読み込み中…", "一覧を取得できませんでした。", { SelectionClient.load(saved) }) {
            showSnapshot(it, if (it.isEmpty()) "選択できるスレッドはありません。" else "スレッド一覧を読み込みました。")
        }
    }

    private fun showSnapshot(snapshot: List<SelectionThread>, message: String) {
        threads.removeAllViews()
        snapshotValid = true
        for (thread in snapshot) {
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
        val saved = credentials ?: return
        if (busy || !snapshotValid || !settingsMatch()) return
        snapshotValid = false
        runRequest("通知対象を保存中…", "保存結果を確認できませんでした。", { SelectionClient.save(saved, id, enabled) }) {
            showSnapshot(it, "サーバーで通知対象の保存を確認しました。")
        }
    }

    private fun <T> runRequest(pending: String, failure: String, work: () -> T, success: (T) -> Unit) {
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
                result.fold(success, { error ->
                    if (!snapshotValid) threads.removeAllViews()
                    feedback.text = when ((error as? SelectionHttpError)?.status ?: 0) {
                        401, 403 -> "$failure URL と選択専用トークンを確認してください。"
                        409, 503 -> "$failure 時間をおいて一覧を再読み込みし、必要なら操作をやり直してください。"
                        in 300..399 -> "$failure リダイレクト先ではなく、選択 API の HTTPS URL を直接指定してください。"
                        else -> if (credentials != null && settingsMatch()) "$failure 一覧を再読み込みしてください。" else failure
                    }
                })
                updateControls()
            }
        }
    }
}
