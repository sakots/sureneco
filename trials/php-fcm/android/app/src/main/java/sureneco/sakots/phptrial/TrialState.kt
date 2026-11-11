package sureneco.sakots.phptrial

import android.content.Context
import android.content.SharedPreferences

/** One process-wide lock covers consent, durable dedupe and notification posting. */
class TrialState(context: Context) {
    private val prefs = context.getSharedPreferences("fcm_trial_private", Context.MODE_PRIVATE)
    data class Snapshot(val enabled: Boolean, val token: String, val registration: String, val receipt: String)
    enum class Delivery { SHOWN, BLOCKED, FAILED }

    @Synchronized fun snapshot() = Snapshot(
        prefs.getBoolean("enabled", false), prefs.getString("token", "").orEmpty(),
        prefs.getString("registration", "未登録（試験は停止中）").orEmpty(),
        prefs.getString("receipt", "まだ受信していません。送信側の受理と端末受信は別です。").orEmpty()
    )

    @Synchronized fun start(): Boolean = prefs.edit().putBoolean("enabled", true)
        .putString("registration", "登録トークンを取得しています…").commit()

    @Synchronized fun stop(): Boolean = prefs.edit().putBoolean("enabled", false).remove("token")
        .putString("registration", "停止中（この端末では通知を表示しません）").commit()

    @Synchronized fun saveToken(token: String): Boolean {
        if (!prefs.getBoolean("enabled", false) || token.isBlank() || token.length > 8192) return false
        return prefs.edit().putString("token", token).putString("registration", "登録済み（FCM 送信先としてコピーできます）").commit()
    }

    @Synchronized fun registrationFailed() {
        if (prefs.getBoolean("enabled", false)) prefs.edit()
            .putString("registration", "トークン取得失敗。通信・Google Play 開発者サービス・Firebase 設定を確認して再取得してください。").commit()
    }

    @Synchronized fun receive(data: Map<String, String>, now: Long, canNotify: Boolean, deliver: (ReceiptPolicy.Payload) -> Delivery) {
        val activeHistory = prefs.getStringSet("seen", emptySet()).orEmpty().mapNotNull { entry ->
            val parts = entry.split(':', limit = 2)
            val expiry = parts.getOrNull(1)?.toLongOrNull() ?: return@mapNotNull null
            if (expiry > now) parts[0] to expiry else null
        }.toMap()
        val decision = ReceiptPolicy.evaluate(data, now, prefs.getBoolean("enabled", false) && canNotify, activeHistory.keys)
        val payload = decision.payload
        if (payload == null) {
            val reason = when (decision.reason) {
                ReceiptPolicy.Reason.STOPPED -> "停止中・通知権限なしのため表示しませんでした"
                ReceiptPolicy.Reason.MALFORMED -> "形式不正のため拒否しました"
                ReceiptPolicy.Reason.EXPIRED -> "有効期限切れのため拒否しました"
                ReceiptPolicy.Reason.DUPLICATE -> "重複受信のため表示しませんでした"
                ReceiptPolicy.Reason.ACCEPTED -> error("Accepted receipt must have a payload")
            }
            prefs.edit().putString("receipt", "端末受信: $now 秒\n$reason").commit()
            return
        }
        // Do not evict still-valid IDs: that would permit replay. Trial traffic is deliberately tiny.
        if (activeHistory.size >= 128) {
            prefs.edit().putString("receipt", "端末受信: $now 秒\n重複防止履歴が満杯のため拒否しました（最大5分後に再試験）。").commit()
            return
        }
        val history = activeHistory.map { "${it.key}:${it.value}" }.toMutableSet()
        history.add("${payload.eventId}:${payload.expiresAt}")
        // If durable storage fails, fail closed rather than post an undeduplicated notification.
        if (!prefs.edit().putStringSet("seen", history)
                .putString("receipt", "端末受信: $now 秒\neventId: ${payload.eventId}\n検証済み（通知処理中）").commit()) return
        val outcome = when (deliver(payload)) {
            Delivery.SHOWN -> "通知を表示しました"
            Delivery.BLOCKED -> "OS の通知設定により表示できませんでした"
            Delivery.FAILED -> "通知処理に失敗しました"
        }
        prefs.edit().putString("receipt", "端末受信: $now 秒\neventId: ${payload.eventId}\n$outcome").commit()
    }

    fun observe(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.registerOnSharedPreferenceChangeListener(listener)
    fun unobserve(listener: SharedPreferences.OnSharedPreferenceChangeListener) = prefs.unregisterOnSharedPreferenceChangeListener(listener)
}
