package sureneco.sakots

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.ActivityCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONObject

@InvokeArg
class MobileArgs { var operation: String = ""; var payload: String = "{}" }
@TauriPlugin
class MobilePlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun execute(invoke: Invoke) {
        val args = invoke.parseArgs(MobileArgs::class.java)
        val data = JSONObject(args.payload)
        fun resolve(value: Any? = null) { invoke.resolve(JSObject().apply { put("value", value ?: JSONObject.NULL) }) }
        try {
            when (args.operation) {
                "notification_target" -> { val p = PushState.prefs(activity); val target = p.getBoolean("showRecruitments", false); p.edit().remove("showRecruitments").commit(); resolve(target) }
                "changing" -> { PushState.changing(activity); resolve() }
                "foreground" -> resolve((activity as androidx.lifecycle.LifecycleOwner).lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))
                "status" -> {
                    val expected = PushState.epoch(activity)
                    resolve(PushState.status(activity))
                    if ((activity as androidx.lifecycle.LifecycleOwner).lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))
                        PushState.executor.execute { try { PushState.refreshStatus(activity) } catch (_: Exception) { PushState.failed(activity, expected) } }
                }
                "permission" -> { if (Build.VERSION.SDK_INT >= 33) ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2001); resolve() }
                "copy" -> { val id = data.getString("id"); require(Regex("[0-9]{5}").matches(id)); activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("ルームID", id)); resolve() }
                "open" -> { val url = data.getString("url"); val parsed = Uri.parse(url); require(parsed.scheme == "https" && (parsed.host?.endsWith(".5ch.io") == true || parsed.host?.endsWith(".5ch.net") == true)); activity.startActivity(Intent(Intent.ACTION_VIEW, parsed)); resolve() }
                "stop", "delete" -> {
                    PushState.suppress(activity, args.operation)
                    val expected = PushState.epoch(activity)
                    if (args.operation == "delete") org.unifiedpush.android.connector.UnifiedPush.unregister(activity)
                    PushState.executor.execute { try { PushState.sync(activity); resolve(PushState.status(activity)) } catch (_: Exception) { PushState.failed(activity, expected); invoke.reject("停止・削除はサーバー受付またはntfy権限撤去の確認待ちです。再試行してください。") } }
                }
                "start" -> {
                    require(data.optBoolean("consent"))
                    val expected = PushState.start(activity, data.getString("saved"))
                    PushState.executor.execute {
                        try { PushState.register(activity, expected, pick = true) { resolve(PushState.status(activity)) } }
                        catch (_: Exception) { PushState.failed(activity, expected); invoke.reject("通知の登録に失敗しました。APIとntfyの設定を確認してください。") }
                    }
                }
                "sync_settings", "sync" -> {
                    if (args.operation == "sync_settings") PushState.settings(activity, data.getString("saved"))
                    val expected = PushState.epoch(activity)
                    PushState.executor.execute {
                        try {
                            if (PushState.active(activity, expected)) PushState.register(activity, expected, pick = false) { resolve(PushState.status(activity)) }
                            else { PushState.sync(activity); resolve(PushState.status(activity)) }
                        } catch (_: Exception) { PushState.failed(activity, expected); invoke.reject("通知設定または停止・削除の確認が未同期です。再試行してください。") }
                    }
                }
                else -> invoke.reject("Androidでは未対応の操作です。")
            }
        } catch (_: Exception) { invoke.reject("端末の操作を完了できませんでした。") }
    }
}
