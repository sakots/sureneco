package sureneco.sakots

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.FailedReason

class RecruitmentPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        if (instance != INSTANCE_DEFAULT) return
        PushState.executor.execute { try { PushState.endpoint(this, endpoint) } catch (_: Exception) { PushState.failed(this) } }
    }
    override fun onRegistrationFailed(reason: FailedReason, instance: String) { PushState.mark(this, "中継アプリ登録失敗") }
    override fun onUnregistered(instance: String) {
        if (instance != INSTANCE_DEFAULT) return
        PushState.suppress(this, "stop")
        PushState.executor.execute { try { PushState.sync(this) } catch (_: Exception) { PushState.failed(this) } }
    }
    override fun onMessage(message: PushMessage, instance: String) {
        if (instance != INSTANCE_DEFAULT || !message.decrypted || message.content.size > 4096) return
        try {
            val data = JSONObject(String(message.content, Charsets.UTF_8))
            if (data.optLong("expiresAt") <= System.currentTimeMillis() / 1000) return
            if (data.optString("type") == "challenge") {
                PushState.executor.execute { try { PushState.confirm(this, data) } catch (_: Exception) { PushState.failed(this) } }
                return
            }
            if (data.optString("type") != "recruitment") return
            val p = PushState.prefs(this)
            val event = data.getString("eventId")
            if (!Regex("[a-f0-9]{64}").matches(event)) return
            val now = System.currentTimeMillis() / 1000
            val seen = JSONObject(p.getString("seen", "{}")!!)
            seen.keys().asSequence().toList().filter { seen.optLong(it) <= now }.forEach { seen.remove(it) }
            if (!NotificationPolicy.accepts(PushState.desired(this), NotificationManagerCompat.from(this).areNotificationsEnabled(), message.decrypted,
                    data.getLong("revision"), p.getLong("revision", 0), data.getString("generation"), p.getString("generation", "")!!,
                    data.getLong("expiresAt"), now, seen.has(event))) return
            val item = data.getJSONObject("recruitment")
            if (item.optBoolean("closed")) return
            seen.put(event, data.getLong("expiresAt"))
            if (!p.edit().putString("seen", seen.toString()).commit()) return
            val manager = getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("recruitments", "友人戦募集", NotificationManager.IMPORTANCE_HIGH))
            val intent = Intent(this, MainActivity::class.java).putExtra("showRecruitments", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(this, "recruitments").setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("友人戦募集 · ${data.getString("threadTitle").take(80)}")
                .setContentText("レス ${item.getInt("number")}：${item.getString("body").take(220)}")
                .setContentIntent(pending).setAutoCancel(true).setTimeoutAfter((data.getLong("expiresAt") - now) * 1000).build()
            NotificationManagerCompat.from(this).notify(event.hashCode(), notification)
        } catch (_: Exception) { /* malformed or stale messages are never displayed */ }
    }
}
