package sureneco.sakots

import android.content.Context
import android.content.SharedPreferences
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import org.unifiedpush.android.connector.data.PushEndpoint
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

object PushState {
    val executor = Executors.newSingleThreadExecutor()
    fun prefs(context: Context): SharedPreferences = context.getSharedPreferences("push-state", Context.MODE_PRIVATE)
    private fun put(context: Context, edit: SharedPreferences.Editor.() -> Unit) {
        if (!prefs(context).edit().apply(edit).commit()) error("通知状態を保存できません。")
    }
    fun desired(context: Context) = prefs(context).getBoolean("enabled", false)
    fun status(context: Context): JSONObject {
        val p = prefs(context)
        return JSONObject().put("enabled", desired(context)).put("status", p.getString("status", "未登録"))
            .put("permission", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("ntfyOrigin", BuildConfig.SURENECO_NTFY_ORIGIN)
            .put("server", p.getString("server", null)?.let { JSONObject(it) } ?: JSONObject.NULL)
    }
    fun mark(context: Context, value: String) = put(context) { putString("status", value) }
    fun suppress(context: Context, pending: String) {
        put(context) { putLong("epoch", prefs(context).getLong("epoch", 0) + 1); putBoolean("enabled", false); putLong("revision", 0); putString("pending", if (prefs(context).getString("pending", null) == "delete") "delete" else pending); putString("status", "停止反映待ち") }
        NotificationManagerCompat.from(context).cancelAll()
    }
    fun start(context: Context, saved: String) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) error("通知を許可してから有効にしてください。")
        put(context) { putLong("epoch", prefs(context).getLong("epoch", 0) + 1); putBoolean("enabled", true); putLong("revision", 0); putString("saved", saved); remove("pending"); putString("status", "中継アプリ登録中") }
    }
    fun settings(context: Context, saved: String) {
        put(context) { putLong("epoch", prefs(context).getLong("epoch", 0) + 1); putString("saved", saved); putLong("revision", 0); putString("status", if (desired(context)) "設定同期中" else "停止中") }
    }
    fun request(context: Context, path: String, method: String, input: JSONObject? = null, anonymous: Boolean = false, credential: String? = null): JSONObject {
        val origin = BuildConfig.SURENECO_API_BASE_URL
        if (!origin.startsWith("https://") || origin.endsWith(".invalid")) error("API接続先が未設定です。")
        val connection = URL(origin + path).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.requestMethod = method
            connection.setRequestProperty("Content-Type", "application/json")
            if (!anonymous) {
                val token = credential ?: prefs(context).getString("token", null) ?: error("端末登録が必要です。")
                connection.setRequestProperty("Authorization", "Bearer $token")
            }
            if (input != null) { connection.doOutput = true; connection.outputStream.use { it.write(input.toString().toByteArray()) } }
            if (connection.responseCode !in 200..299) error("通知サーバーへの要求が失敗しました（${connection.responseCode}）。")
            val bytes = connection.inputStream.use { stream ->
                val result = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) { val count = stream.read(buffer); if (count < 0) break; result.write(buffer, 0, count); if (result.size() > 262144) error("応答サイズが上限を超えました。") }
                result.toByteArray()
            }
            return JSONObject(String(bytes, Charsets.UTF_8))
        } finally { connection.disconnect() }
    }
    fun prepare(context: Context): String {
        val config = request(context, "/v1/push-config", "GET", anonymous = true)
        if (config.getString("ntfyOrigin") != BuildConfig.SURENECO_NTFY_ORIGIN) error("通知サーバーの接続先が一致しません。")
        if (prefs(context).getString("token", null) == null) {
            val device = request(context, "/v1/device", "POST", JSONObject().put("consent", true), true)
            put(context) { putString("token", device.getString("token")); putLong("tokenCreatedAt", System.currentTimeMillis()) }
        }
        if (prefs(context).getString("rotationNext", null) != null || System.currentTimeMillis() - prefs(context).getLong("tokenCreatedAt", 0) >= 30L * 86400000) rotate(context)
        return config.getString("vapidPublicKey")
    }
    private fun rotate(context: Context) {
        val p = prefs(context)
        val next = p.getString("rotationNext", null) ?: run {
            val bytes = ByteArray(32); java.security.SecureRandom().nextBytes(bytes)
            android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        }
        put(context) { putString("rotationNext", next) }
        try {
            request(context, "/v1/device/rotate", "POST", JSONObject().put("newToken", next))
        } catch (_: Exception) {
            // If the response was lost after commit, the new credential proves completion.
            request(context, "/v1/subscription", "GET", credential = next)
        }
        put(context) { putString("token", next); remove("rotationNext"); putLong("tokenCreatedAt", System.currentTimeMillis()) }
    }
    fun endpoint(context: Context, endpoint: PushEndpoint) {
        if (!desired(context)) return
        val keys = endpoint.pubKeySet ?: error("暗号化に対応する中継アプリが必要です。")
        val url = java.net.URI(endpoint.url)
        if (url.scheme != "https" || "https://${url.rawAuthority}" != BuildConfig.SURENECO_NTFY_ORIGIN || !Regex("/up[A-Za-z0-9_-]{1,62}").matches(url.rawPath) || (url.rawQuery != null && url.rawQuery != "up=1") || url.fragment != null) error("自前ntfyの通知先を設定してください。")
        val sub = JSONObject().put("endpoint", endpoint.url.substringBefore("?")).put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth)).toString()
        val changed = prefs(context).getString("subscription", null) != sub
        put(context) { putString("subscription", sub); if (changed) { putLong("epoch", prefs(context).getLong("epoch", 0) + 1); putLong("revision", 0) }; putString("status", "通知先確認中") }
        sync(context)
    }
    private fun applyView(context: Context, response: JSONObject, epoch: Long) {
        val sub = response.optJSONObject("subscription") ?: return
        if (!desired(context) || prefs(context).getLong("epoch", 0) != epoch) return
        put(context) {
            putString("server", sub.toString()); putString("generation", sub.getString("generation"))
            if (sub.optBoolean("active") && sub.optBoolean("channelConfirmed")) { putLong("revision", sub.getLong("revision")); putString("status", "監視中") }
            else putString("status", "通知先確認中")
        }
    }
    fun sync(context: Context) {
        val p = prefs(context)
        val pending = p.getString("pending", null)
        if (pending != "delete" && p.getString("rotationNext", null) != null) rotate(context)
        if (pending != null) {
            if (p.getString("token", null) != null) request(context, if (pending == "delete") "/v1/device" else "/v1/subscription/stop", if (pending == "delete") "DELETE" else "POST")
            if (pending == "delete" && p.getString("rotationNext", null) != null) request(context, "/v1/device", "DELETE", credential = p.getString("rotationNext", null))
            put(context) { remove("pending"); if (pending == "delete") { remove("token"); remove("rotationNext"); remove("tokenCreatedAt"); remove("subscription"); remove("server"); remove("generation"); remove("seen") }; putString("status", if (pending == "delete") "登録削除済み" else "停止中") }
            return
        }
        if (!desired(context)) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) { suppress(context, "stop"); sync(context); return }
        val saved = p.getString("saved", null)?.let { JSONObject(it) } ?: return
        val subscription = p.getString("subscription", null)?.let { JSONObject(it) } ?: return
        val settings = saved.getJSONObject("settings")
        settings.keys().asSequence().filter { it.startsWith("launcher_") }.toList().forEach { settings.remove(it) }
        val input = JSONObject().put("settings", settings).put("watched", saved.getJSONArray("watched")).put("consent", true).put("pushSubscription", subscription)
        val epoch = p.getLong("epoch", 0)
        applyView(context, request(context, "/v1/subscription", "PUT", input), epoch)
    }
    fun confirm(context: Context, data: JSONObject) {
        if (!desired(context)) return
        val epoch = prefs(context).getLong("epoch", 0)
        val result = request(context, "/v1/subscription/confirm", "POST", JSONObject().put("challenge", data.getString("challenge")).put("generation", data.getString("generation")))
        applyView(context, result, epoch)
    }
    fun refreshStatus(context: Context) {
        val p = prefs(context)
        if (!desired(context) || p.getLong("revision", 0) <= 0 || System.currentTimeMillis() - p.getLong("statusAt", 0) < 60000) return
        put(context) { putLong("statusAt", System.currentTimeMillis()) }
        val response = request(context, "/v1/subscription", "GET")
        val sub = response.optJSONObject("subscription")
        put(context) { putString("server", sub?.toString()) }
        if (sub == null || !sub.optBoolean("active")) mark(context, "サーバー監視停止：同期を確認してください")
    }
    fun failed(context: Context) = mark(context, "未同期：通信・中継アプリの設定を確認してください")
}
