package sureneco.sakots.phptrial

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.IOException
import java.util.concurrent.Executors

/** Holds the authenticated state and in-flight request across Activity recreation. */
internal class SelectionSession(private val state: TrialState, private val publicRegistration: PublicRegistration? = null) {
    data class Notice(val text: String, val error: Boolean = false)

    private data class Response(val bearer: String, val snapshot: MonitoringSnapshot, val saved: Boolean)
    private class RegistrationChanged : IOException()

    companion object {
        // Queue a new read behind any write already sent by a previous Activity.
        private val requests = Executors.newSingleThreadExecutor()
        private const val REFRESH_MILLIS = 60_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private var registration: String? = null
    private var generation = 0
    private var bearer: String? = null
    private var lastRequestAt = -REFRESH_MILLIS
    private var needsManualReload = false

    var onChanged: (() -> Unit)? = null
    var snapshot: MonitoringSnapshot? = null
        private set
    var notice: Notice? = null
        private set
    var busy = false
        private set
    val registered get() = registration != null
    val canWrite get() = snapshot != null && bearer != null && !busy && notice?.error != true

    private fun currentRegistration(): String? {
        if (publicRegistration != null) return publicRegistration.selectionBearer
        val current = state.snapshot()
        return current.token.takeIf { current.enabled && it.isNotBlank() }
    }

    private fun syncRegistration() {
        val current = currentRegistration()
        if (current == registration) return
        registration = current
        generation++
        bearer = null
        snapshot = null
        notice = null
        needsManualReload = false
        lastRequestAt = -REFRESH_MILLIS
        onChanged?.invoke()
    }

    fun refresh(force: Boolean = false) {
        syncRegistration()
        if (busy || registration == null) return
        if (!force && (needsManualReload || SystemClock.elapsedRealtime() - lastRequestAt < REFRESH_MILLIS)) return
        runRequest(null, null)
    }

    fun saveThread(id: String, enabled: Boolean) =
        save("通知対象を保存中…", "通知対象を保存しました。") { SelectionClient.save(it, id, enabled) }

    fun saveSettings(settings: MonitoringSettings) =
        save("設定を保存中…", "設定を保存しました。") { SelectionClient.saveSettings(it, settings) }

    private fun save(pending: String, success: String, write: (String) -> MonitoringSnapshot) {
        syncRegistration()
        if (canWrite) runRequest(pending, success, write)
    }

    private fun runRequest(pending: String?, success: String?, write: ((String) -> MonitoringSnapshot)? = null) {
        val registeredToken = registration ?: return
        val requestGeneration = generation
        val knownBearer = bearer
        busy = true
        notice = Notice(pending ?: if (snapshot == null) "サーバーから読み込み中…" else "サーバーから更新中…")
        lastRequestAt = SystemClock.elapsedRealtime()
        onChanged?.invoke()
        requests.execute {
            val result = try {
                fun requireRegistration() {
                    if (currentRegistration() != registeredToken) throw RegistrationChanged()
                }
                fun exchangeAndLoad(): Response {
                    requireRegistration()
                    val refreshed = if (publicRegistration != null) registeredToken else SelectionClient.exchange(registeredToken)
                    requireRegistration()
                    return Response(refreshed, SelectionClient.load(refreshed), false)
                }

                requireRegistration()
                val response = if (knownBearer == null) exchangeAndLoad() else {
                    try {
                        val updated = if (write == null) SelectionClient.load(knownBearer) else write(knownBearer)
                        Response(knownBearer, updated, write != null)
                    } catch (error: SelectionHttpError) {
                        if (error.status != 401 || publicRegistration != null) throw error
                        // Recover by reading the current state; never replay a write.
                        exchangeAndLoad()
                    }
                }
                Result.success(response)
            } catch (error: Exception) {
                Result.failure(error)
            }
            main.post {
                busy = false
                syncRegistration()
                if (requestGeneration == generation) {
                    result.fold({ response ->
                        bearer = response.bearer
                        snapshot = response.snapshot
                        needsManualReload = false
                        notice = when {
                            response.saved -> success?.let { Notice(it) }
                            write != null -> Notice("認証が切れたため保存しませんでした。最新の状態を読み込んだので、必要なら操作をやり直してください。")
                            else -> null
                        }
                        response.snapshot.serverEnabled?.let { publicRegistration?.syncServerEnabled(it) }
                    }, { error ->
                        showFailure(error, write != null)
                    })
                    onChanged?.invoke()
                } else {
                    onChanged?.invoke()
                    if (onChanged != null) refresh()
                }
            }
        }
    }

    private fun showFailure(error: Throwable, saving: Boolean) {
        val status = (error as? SelectionHttpError)?.status
        if (saving && status == 400) {
            notice = Notice("保存できませんでした。入力内容（募集期限の JavaScript 正規表現など）を確認してください。", error = true)
            return
        }
        val prefix = if (saving) "保存結果を確認できませんでした。" else "サーバーから読み込めませんでした。"
        val help = when (status) {
            401, 403 -> {
                bearer = null
                snapshot = null
                needsManualReload = true
                if (publicRegistration != null) {
                    if (status == 401) publicRegistration.requireProof()
                    "端末の通知設定から登録を再試行してください。"
                } else {
                    "サーバーの通知先が端末の現在の登録トークンと一致していることを確認し、再読み込みしてください。"
                }
            }
            409, 503 -> "サーバーの処理が完了してから再読み込みしてください。"
            else -> if (error is RegistrationChanged) "端末の登録情報が変わりました。再読み込みしてください。"
                else "接続とサーバーの状態を確認し、再読み込みしてください。"
        }
        val stale = if (snapshot == null) "" else " 前回取得した内容を表示しています。"
        notice = Notice("$prefix $help$stale", error = true)
    }
}
