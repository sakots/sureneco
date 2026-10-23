package sureneco.sakots

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.UnifiedPush
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

object PushState {
    val executor = Executors.newSingleThreadExecutor()
    fun prefs(context: Context): SharedPreferences = context.getSharedPreferences("push-state", Context.MODE_PRIVATE)
    private fun put(context: Context, edit: SharedPreferences.Editor.() -> Unit) {
        if (!prefs(context).edit().apply(edit).commit()) error("通知状態を保存できません。")
    }
    @Synchronized fun epoch(context: Context) = prefs(context).getLong("epoch", 0)
    @Synchronized fun desired(context: Context) = prefs(context).getBoolean("enabled", false)
    @Synchronized fun active(context: Context, expected: Long) =
        epoch(context) == expected && desired(context) && prefs(context).getString("pending", null) == null

    @Synchronized fun status(context: Context): JSONObject {
        val p = prefs(context)
        return JSONObject().put("enabled", desired(context)).put("status", p.getString("status", "未登録"))
            .put("permission", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("ntfyOrigin", BuildConfig.SURENECO_NTFY_ORIGIN)
            .put("server", p.getString("server", null)?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("registration", p.getString("registration", null)?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("pendingAction", p.getString("pending", null) ?: JSONObject.NULL)
    }
    @Synchronized fun mark(context: Context, value: String, expected: Long) {
        if (active(context, expected)) put(context) { putString("status", value) }
    }
    fun suppress(context: Context, pending: String) {
        synchronized(this) {
            val action = if (prefs(context).getString("pending", null) == "delete") "delete" else pending
            put(context) {
                putLong("epoch", epoch(context) + 1); putBoolean("enabled", false); putLong("revision", 0)
                putString("pending", action); putBoolean("stopAwaiting", false); putLong("pollAt", 0)
                putString("status", if (action == "delete") "端末削除のサーバー反映待ち" else "停止のサーバー反映待ち")
            }
        }
        NotificationManagerCompat.from(context).cancelAll()
    }
    @Synchronized fun start(context: Context, saved: String): Long {
        check(prefs(context).getString("pending", null) != "delete") { "端末削除の受付を確認してから有効にしてください。" }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) error("通知を許可してから有効にしてください。")
        val next = epoch(context) + 1
        put(context) {
            putLong("epoch", next); putBoolean("enabled", true); putLong("revision", 0); putString("saved", saved)
            remove("pending"); putBoolean("stopAwaiting", false); putLong("pollAt", 0); putLong("subscriptionAt", 0)
            putString("status", "中継アプリ登録中")
        }
        return next
    }
    @Synchronized fun settings(context: Context, saved: String) {
        put(context) {
            putLong("epoch", epoch(context) + 1); putString("saved", saved); putLong("revision", 0)
            putLong("pollAt", 0); putLong("subscriptionAt", 0)
            if (desired(context)) putString("status", "設定同期中")
        }
    }
    fun changing(context: Context) {
        synchronized(this) {
            put(context) {
                putLong("epoch", epoch(context) + 1); putLong("revision", 0); putLong("pollAt", 0)
                if (desired(context)) putString("status", "設定未同期")
            }
        }
        NotificationManagerCompat.from(context).cancelAll()
    }

    private fun request(path: String, method: String, input: JSONObject? = null, credential: String? = null): JSONObject {
        val origin = BuildConfig.SURENECO_API_BASE_URL
        if (!origin.startsWith("https://") || origin.endsWith(".invalid")) error("API接続先が未設定です。")
        val connection = URL(origin + path).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.requestMethod = method
            connection.setRequestProperty("Content-Type", "application/json")
            if (credential != null) connection.setRequestProperty("Authorization", "Bearer $credential")
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
    private fun registration(value: JSONObject?): NtfyRegistration? {
        if (value == null) return null
        val state = value.getString("state")
        check(state == "pending" || state == "ready" || state == "stopped") { "ntfyの登録状態が不正です。" }
        return NtfyRegistration(value.getString("topic"), value.getString("username"), value.getString("password"),
            state, if (value.isNull("error")) null else value.getString("error"))
    }
    private fun registrationJson(value: NtfyRegistration) = JSONObject().put("topic", value.topic)
        .put("username", value.username).put("password", value.password).put("state", value.state)
        .put("error", value.error ?: JSONObject.NULL)

    @Synchronized private fun lifecycleState(context: Context): PushRegistrationLifecycle.State {
        val p = prefs(context)
        return PushRegistrationLifecycle.State(epoch(context), desired(context), p.getString("pending", null),
            p.getBoolean("stopAwaiting", false), p.getString("token", null), p.getString("rotationNext", null),
            p.getString("cleanupToken", null), p.getString("subscription", null)?.let { java.net.URI(JSONObject(it).getString("endpoint")).path.removePrefix("/") },
            registration(p.getString("registration", null)?.let { JSONObject(it) }), p.getLong("registrationEpoch", -1),
            p.getString("status", "未登録")!!)
    }
    private fun lifecycle(context: Context) = PushRegistrationLifecycle(object : PushRegistrationLifecycle.Port {
        override fun state() = lifecycleState(context)
        override fun apply(expected: PushRegistrationLifecycle.State, change: PushRegistrationLifecycle.Change): Boolean = synchronized(this@PushState) {
            val current = state()
            if (!PushRegistrationLifecycle.sameOperation(expected, current)) return@synchronized false
            val next = PushRegistrationLifecycle.transition(current, change)
            put(context) {
                putBoolean("enabled", next.enabled); putString("pending", next.pendingAction); putBoolean("stopAwaiting", next.stopAwaiting)
                putString("token", next.token); putString("rotationNext", next.nextToken); putString("cleanupToken", next.cleanupToken)
                putString("registration", next.registration?.let { registrationJson(it).toString() }); putLong("registrationEpoch", next.registrationEpoch)
                putString("status", next.status)
                if (change is PushRegistrationLifecycle.Change.Registration) {
                    if (change.value.state != "ready") putLong("revision", 0)
                    else if (prefs(context).getLong("revision", 0) > 0) putString("status", "監視中")
                }
                if (change is PushRegistrationLifecycle.Change.TokenIssued || change is PushRegistrationLifecycle.Change.Rotated)
                    putLong("tokenCreatedAt", System.currentTimeMillis())
                if (change is PushRegistrationLifecycle.Change.Deleted) {
                    remove("tokenCreatedAt"); remove("subscription"); remove("server"); remove("generation"); remove("seen")
                    remove("subscriptionAt"); putLong("revision", 0)
                }
            }
            true
        }
        override fun putRegistration(token: String, topic: String) =
            registration(request("/v1/ntfy-registration", "PUT", JSONObject().put("topic", topic), token).optJSONObject("registration"))
        override fun getRegistration(token: String) =
            registration(request("/v1/ntfy-registration", "GET", credential = token).optJSONObject("registration"))
        override fun stopSubscription(token: String) { request("/v1/subscription/stop", "POST", credential = token) }
        override fun deleteDevice(token: String) { request("/v1/device", "DELETE", credential = token) }
        override fun issueDevice() = request("/v1/device", "POST", JSONObject().put("consent", true)).getString("token")
        override fun newToken(): String {
            val bytes = ByteArray(32); java.security.SecureRandom().nextBytes(bytes)
            return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        }
        override fun rotateDevice(token: String, next: String) { request("/v1/device/rotate", "POST", JSONObject().put("newToken", next), token) }
        override fun probeDevice(token: String) { request("/v1/subscription", "GET", credential = token) }
        override fun retainCleanupToken(token: String) {
            synchronized(this@PushState) { put(context) { putString("cleanupToken", token) } }
        }
    })

    fun prepare(context: Context, expected: Long): String? {
        if (!active(context, expected)) return null
        val config = request("/v1/push-config", "GET")
        if (!active(context, expected)) return null
        if (config.getString("ntfyOrigin") != BuildConfig.SURENECO_NTFY_ORIGIN) error("通知サーバーの接続先が一致しません。")
        val rotate = synchronized(this) {
            prefs(context).getString("token", null) != null && System.currentTimeMillis() - prefs(context).getLong("tokenCreatedAt", 0) >= 30L * 86400000
        }
        if (!lifecycle(context).prepareCredentials(rotate, expected)) return null
        return if (active(context, expected)) config.getString("vapidPublicKey") else null
    }

    /** Both distributor selection and its asynchronous callback are guarded by the initiating epoch. */
    fun register(activity: Activity, expected: Long, pick: Boolean, complete: () -> Unit) {
        val vapid = prepare(activity, expected) ?: run { complete(); return }
        sync(activity)
        activity.runOnUiThread {
            synchronized(this) {
                if (!active(activity, expected)) { complete(); return@runOnUiThread }
                val callback: (Boolean) -> Unit = { success ->
                    synchronized(this) {
                        if (active(activity, expected)) {
                            if (success) UnifiedPush.register(activity, messageForDistributor = "スレネコチェッカーの友人戦募集通知", vapid = vapid)
                            else mark(activity, "中継アプリ未導入：ntfyを導入して自前サーバーを設定してください", expected)
                        }
                    }
                    complete()
                }
                if (pick) UnifiedPush.tryPickDistributor(activity) { callback(it) }
                else UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { callback(it) }
            }
        }
    }
    fun endpoint(context: Context, endpoint: PushEndpoint, expected: Long): Long? {
        if (!active(context, expected)) return null
        val keys = endpoint.pubKeySet ?: error("暗号化に対応する中継アプリが必要です。")
        val url = java.net.URI(endpoint.url)
        if (url.scheme != "https" || "https://${url.rawAuthority}" != BuildConfig.SURENECO_NTFY_ORIGIN || !Regex("/up[A-Za-z0-9_-]{1,62}").matches(url.rawPath) || (url.rawQuery != null && url.rawQuery != "up=1") || url.fragment != null) error("自前ntfyの通知先を設定してください。")
        val sub = JSONObject().put("endpoint", endpoint.url.substringBefore("?")).put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth)).toString()
        val operation = synchronized(this) {
            if (!active(context, expected)) return null
            val changed = prefs(context).getString("subscription", null) != sub
            put(context) {
                putString("subscription", sub)
                if (changed) {
                    putLong("epoch", epoch(context) + 1); putLong("revision", 0); remove("registration"); putLong("registrationEpoch", -1)
                    putLong("subscriptionAt", 0); putLong("pollAt", 0)
                }
                putString("status", "ntfyアカウント準備中")
            }
            epoch(context)
        }
        return operation
    }
    @Synchronized private fun applyView(context: Context, response: JSONObject, expected: Long, token: String) {
        if (!active(context, expected) || prefs(context).getString("token", null) != token) return
        val sub = response.optJSONObject("subscription") ?: return
        put(context) {
            putString("server", sub.toString()); putString("generation", sub.getString("generation"))
            if (sub.optBoolean("active") && sub.optBoolean("channelConfirmed")) { putLong("revision", sub.getLong("revision")); putString("status", "監視中") }
            else putString("status", "通知先確認中")
        }
    }
    fun sync(context: Context, force: Boolean = true) {
        val state = lifecycleState(context)
        if (state.enabled && !NotificationManagerCompat.from(context).areNotificationsEnabled()) { suppress(context, "stop"); sync(context, force); return }
        if (state.enabled && state.token == null && prepare(context, state.epoch) == null) return
        val ready = lifecycle(context).sync() ?: return
        val input = synchronized(this) {
            if (!active(context, ready.epoch) || prefs(context).getString("token", null) != ready.token) return
            val p = prefs(context)
            val saved = p.getString("saved", null)?.let { JSONObject(it) } ?: return
            val subscription = p.getString("subscription", null)?.let { JSONObject(it) } ?: return
            if (!force && (p.getLong("revision", 0) > 0 || !PushRegistrationLifecycle.pollDue(System.currentTimeMillis(), p.getLong("subscriptionAt", 0), 60000))) return
            val settings = saved.getJSONObject("settings")
            settings.keys().asSequence().filter { it.startsWith("launcher_") }.toList().forEach { settings.remove(it) }
            put(context) { putLong("subscriptionAt", System.currentTimeMillis()) }
            JSONObject().put("settings", settings).put("watched", saved.getJSONArray("watched")).put("consent", true).put("pushSubscription", subscription)
        }
        if (!active(context, ready.epoch)) return
        applyView(context, request("/v1/subscription", "PUT", input, ready.token), ready.epoch, ready.token)
    }
    fun confirm(context: Context, data: JSONObject, expected: Long) {
        val token = synchronized(this) {
            if (!active(context, expected) || prefs(context).getString("generation", null) != data.getString("generation")) return
            val state = lifecycleState(context)
            if (state.registrationEpoch != expected || state.registration?.state != "ready") return
            state.token ?: return
        }
        if (!active(context, expected)) return
        val result = request("/v1/subscription/confirm", "POST", JSONObject().put("challenge", data.getString("challenge")).put("generation", data.getString("generation")), token)
        applyView(context, result, expected, token)
    }
    fun refreshStatus(context: Context) {
        val state = synchronized(this) {
            val current = lifecycleState(context)
            if (!current.enabled && current.pendingAction == null && !current.stopAwaiting && current.cleanupToken == null) return
            val now = System.currentTimeMillis()
            val interval = if (current.pendingAction != null || current.stopAwaiting || current.registration?.state != "ready") 5000L else 60000L
            if (!PushRegistrationLifecycle.pollDue(now, prefs(context).getLong("pollAt", 0), interval)) return
            put(context) { putLong("pollAt", now) }
            current
        }
        sync(context, force = false)
        val token = synchronized(this) {
            if (!active(context, state.epoch) || prefs(context).getLong("revision", 0) <= 0) return
            prefs(context).getString("token", null) ?: return
        }
        if (!active(context, state.epoch)) return
        val response = request("/v1/subscription", "GET", credential = token)
        synchronized(this) {
            if (!active(context, state.epoch) || prefs(context).getString("token", null) != token) return
            val sub = response.optJSONObject("subscription")
            put(context) {
                putString("server", sub?.toString())
                if (sub == null || !sub.optBoolean("active")) { putLong("revision", 0); putString("status", "サーバー監視停止：同期を確認してください") }
            }
        }
    }
    @Synchronized fun failed(context: Context, expected: Long) {
        if (epoch(context) != expected) return
        val p = prefs(context)
        val value = when {
            p.getString("pending", null) == "delete" -> "端末削除のサーバー反映待ち：再試行してください"
            p.getString("pending", null) == "stop" -> "停止のサーバー反映待ち：再試行してください"
            p.getBoolean("stopAwaiting", false) -> "停止受付済み：ntfy権限撤去を確認できません（再試行してください）"
            desired(context) -> "未同期：API・ntfyの設定を確認して再試行してください"
            else -> return
        }
        put(context) { putString("status", value) }
    }
}
