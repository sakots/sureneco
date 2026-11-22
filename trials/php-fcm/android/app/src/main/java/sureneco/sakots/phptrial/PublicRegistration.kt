package sureneco.sakots.phptrial

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessaging
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class RegistrationChallenge(val id: String, val code: String, val expiresAt: Long) {
    companion object {
        val idPattern = Regex("[0-9a-f]{32}")
        private val codePattern = Regex("[0-9a-f]{64}")

        fun parse(data: Map<String, String>, now: Long): RegistrationChallenge? {
            if (data["type"] != "registration_challenge") return null
            val id = data["challengeId"]?.takeIf(idPattern::matches) ?: return null
            val code = data["code"]?.takeIf(codePattern::matches) ?: return null
            val expiresAt = data["expiresAt"]?.toLongOrNull()?.takeIf { it > now } ?: return null
            return RegistrationChallenge(id, code, expiresAt)
        }
    }
}

/** Process-wide coordinator. Mutations run on the main thread, HTTP on one worker. */
internal class PublicRegistration(private val app: TrialApplication) {
    enum class Action(val wire: String) { PAUSE("pause"), RESUME("resume"), DELETE("delete") }

    // The app excludes shared preferences from both cloud backup and device transfer.
    private val prefs = app.getSharedPreferences("fcm_public_private", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val requests = Executors.newSingleThreadExecutor()
    private val random = SecureRandom()
    private val timeout = Runnable { show("確認メッセージを受信できませんでした。端末の通信と時計を確認して再試行してください。") }
    private var earlyChallenge: RegistrationChallenge? = null
    private var fetching = false
    private var inFlight = false
    private var tokenRevision = 0
    private var ownershipPersisted = started

    var onChanged: (() -> Unit)? = null
    var message = ""
        private set

    private val bearer get() = prefs.getString("bearer", null)
    private val token get() = prefs.getString("token", null)
    private val provenToken get() = prefs.getString("proven_token", null)
    private val challengeId get() = prefs.getString("challenge_id", null)
    val pending get() = prefs.getString("pending_action", null)?.let { name -> Action.entries.firstOrNull { it.wire == name } }
    val started get() = bearer != null
    val enrolled get() = provenToken != null
    val current get() = token != null && token == provenToken
    val paused get() = prefs.getBoolean("paused", false)
    val busy get() = fetching || inFlight
    val waiting get() = challengeId != null && message == WAITING
    val selectionBearer get() = bearer.takeIf { current && pending == null }
    val canNotify get() = enrolled && !paused && pending != Action.PAUSE && pending != Action.DELETE

    fun recover() {
        if (started && message.isEmpty() && pending == null && TrialNotifications.allowed(app)) startOrRetry()
    }

    fun syncServerEnabled(enabled: Boolean) {
        if (!current || pending != null || paused == !enabled) return
        val stored = synchronized(app.state) {
            val saved = prefs.edit().putBoolean("paused", !enabled).commit()
            if (!enabled) TrialNotifications.clear(app)
            saved
        }
        if (!stored) showStorageFailure()
        else show(if (enabled) "登録済み" else "登録済み（監視停止中）")
    }

    fun requireProof() {
        if (!clearChallenge(prefs.edit()).remove("proven_token").commit()) {
            showStorageFailure()
        } else {
            show("サーバーで登録を確認できませんでした。登録を再試行してください。")
        }
    }

    fun startOrRetry() {
        if (busy) return
        pending?.let { change(it); return }
        if (!app.firebaseReady) return
        val secret = bearer ?: newBearer()
        // Never send begin before the installation's ownership credential is durable.
        if (!prefs.edit().putString("bearer", secret).commit()) {
            showStorageFailure()
            return
        }
        ownershipPersisted = true
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        fetching = true
        val revision = tokenRevision
        show("通知の登録情報を取得しています…")
        messaging.token.addOnCompleteListener { result ->
            fetching = false
            if (!started || pending != null) return@addOnCompleteListener
            val fresh = if (result.isSuccessful) result.result.orEmpty() else ""
            when {
                revision != tokenRevision -> advance(retry = true)
                fresh.isBlank() || fresh.length > 8192 ->
                    show("通知の登録情報を取得できませんでした。通信を確認して再試行してください。")
                rememberToken(fresh) -> advance(retry = true)
                else -> Unit
            }
        }
    }

    fun onNewToken(fresh: String) = fromFcm {
        if (!ownershipPersisted || !started || !rememberToken(fresh)) return@fromFcm
        if (!current && !busy && pending == null) advance()
    }

    fun onChallenge(data: Map<String, String>) {
        val proof = RegistrationChallenge.parse(data, now()) ?: return
        fromFcm {
            if (!ownershipPersisted || !started || current || pending != null) return@fromFcm
            if (proof.id == challengeId) acceptProof(proof)
            else if (challengeId == null && inFlight) earlyChallenge = proof
        }
    }

    fun change(action: Action) {
        val secret = bearer ?: return
        if (busy || (action != Action.DELETE && pending?.let { it != action } == true)) return
        val stored = synchronized(app.state) {
            val saved = prefs.edit().putString("pending_action", action.wire).commit()
            if (action != Action.RESUME) TrialNotifications.clear(app)
            saved
        }
        if (!stored) {
            showStorageFailure()
            return
        }
        main.removeCallbacks(timeout)
        inFlight = true
        show(when (action) {
            Action.PAUSE -> "サーバーの監視を停止しています…"
            Action.RESUME -> "サーバーの監視を再開しています…"
            Action.DELETE -> "サーバーの登録を削除しています…"
        })
        request({ SelectionClient.changeRegistration(secret, action) }) { result ->
            inFlight = false
            val alreadyDeleted = action == Action.DELETE && (result.exceptionOrNull() as? SelectionHttpError)?.status == 401
            if (result.isSuccess || alreadyDeleted) {
                val edit = prefs.edit()
                if (action == Action.DELETE) edit.clear()
                else edit.remove("pending_action").putBoolean("paused", action == Action.PAUSE)
                if (!edit.commit()) {
                    showStorageFailure()
                    return@request
                }
                if (action == Action.DELETE) {
                    if (app.firebaseReady) FirebaseMessaging.getInstance().isAutoInitEnabled = false
                    show("サーバーと端末の登録を削除しました。")
                } else {
                    show(if (paused) "サーバーの監視を停止しました。" else "サーバーの監視を再開しました。")
                    if (!current) advance()
                }
            } else {
                show("サーバーでの操作結果を確認できませんでした。通信を確認して再試行してください。")
            }
        }
    }

    private fun rememberToken(fresh: String): Boolean {
        if (fresh.isBlank() || fresh.length > 8192) return false
        if (fresh == token) return true
        tokenRevision++
        main.removeCallbacks(timeout)
        earlyChallenge = null
        val stored = clearChallenge(prefs.edit()).putString("token", fresh).commit()
        if (!stored) showStorageFailure()
        return stored
    }

    private fun advance(retry: Boolean = false) {
        if (busy || pending != null) return
        val secret = bearer ?: return
        val destination = token ?: return
        if (current) {
            show(if (paused) "登録済み（監視停止中）" else "通知先の確認が完了しました。")
            return
        }
        val proof = savedProof()
        if (proof != null) {
            finish(secret, destination, proof)
            return
        }
        if (!retry && challengeId != null) {
            waitForProof()
            return
        }
        if (!clearChallenge(prefs.edit()).commit()) {
            showStorageFailure()
            return
        }
        earlyChallenge = null
        inFlight = true
        show("サーバーに通知先の確認を要求しています…")
        request({ SelectionClient.beginRegistration(destination, secret) }) { result ->
            inFlight = false
            if (destination != token) {
                advance()
                return@request
            }
            val id = result.getOrNull()
            if (id == null) {
                show("確認の要求に失敗しました。通信を確認して再試行してください。")
                return@request
            }
            if (!prefs.edit().putString("challenge_id", id).commit()) {
                showStorageFailure()
                return@request
            }
            val early = earlyChallenge.takeIf { it?.id == id }
            earlyChallenge = null
            if (early != null) acceptProof(early) else waitForProof()
        }
    }

    private fun acceptProof(proof: RegistrationChallenge) {
        if (proof.expiresAt <= now()) return
        if (!prefs.edit().putString("challenge_code", proof.code).putLong("challenge_expiry", proof.expiresAt).commit()) {
            showStorageFailure()
            return
        }
        main.removeCallbacks(timeout)
        advance()
    }

    private fun savedProof(): RegistrationChallenge? {
        val id = challengeId ?: return null
        val code = prefs.getString("challenge_code", null) ?: return null
        val expiry = prefs.getLong("challenge_expiry", 0)
        return if (expiry > now()) RegistrationChallenge(id, code, expiry) else null
    }

    private fun finish(secret: String, destination: String, proof: RegistrationChallenge) {
        inFlight = true
        show("受信を確認しました。サーバーに登録しています…")
        request({ SelectionClient.finishRegistration(secret, proof) }) { result ->
            inFlight = false
            if (result.isSuccess) {
                val edit = prefs.edit().putString("proven_token", destination)
                if (destination == token) clearChallenge(edit)
                if (!edit.commit()) {
                    showStorageFailure()
                    return@request
                }
                advance()
            } else if (destination != token) {
                advance()
            } else {
                val status = (result.exceptionOrNull() as? SelectionHttpError)?.status
                if (status in listOf(400, 401, 403, 404, 410) && !clearChallenge(prefs.edit()).commit()) {
                    showStorageFailure()
                } else {
                    show("通知先の登録を確認できませんでした。再試行してください。")
                }
            }
        }
    }

    private fun waitForProof() {
        main.removeCallbacks(timeout)
        main.postDelayed(timeout, 30_000L)
        show(WAITING)
    }

    private fun clearChallenge(edit: android.content.SharedPreferences.Editor) =
        edit.remove("challenge_id").remove("challenge_code").remove("challenge_expiry")

    private fun showStorageFailure() = show("登録情報を端末に保存できませんでした。空き容量を確認して再試行してください。")

    private fun show(value: String) {
        message = value
        onChanged?.invoke()
    }

    private fun newBearer(): String {
        val bytes = ByteArray(32).also(random::nextBytes)
        return buildString(64) {
            for (byte in bytes) {
                val value = byte.toInt() and 255
                append(HEX[value ushr 4])
                append(HEX[value and 15])
            }
        }
    }

    private fun now() = System.currentTimeMillis() / 1000L

    // Keep the FCM callback alive while the main thread durably records the token or proof.
    // The server request itself remains asynchronous; a later app launch can retry the saved proof.
    private fun fromFcm(block: () -> Unit) {
        if (Looper.myLooper() == main.looper) {
            block()
            return
        }
        val recorded = CountDownLatch(1)
        if (main.post {
                try {
                    block()
                } finally {
                    recorded.countDown()
                }
            }) {
            try {
                recorded.await(3, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    private fun <T> request(work: () -> T, complete: (Result<T>) -> Unit) {
        requests.execute {
            val result = try {
                Result.success(work())
            } catch (error: Exception) {
                Result.failure(error)
            }
            main.post { complete(result) }
        }
    }

    private companion object {
        const val HEX = "0123456789abcdef"
        const val WAITING = "この端末に届く登録確認メッセージを待っています…"
    }
}
