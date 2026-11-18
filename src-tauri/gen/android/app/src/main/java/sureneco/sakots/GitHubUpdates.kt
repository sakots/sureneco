package sureneco.sakots

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

internal class GitHubUpdates(
    private val version: String,
    debug: Boolean,
    installer: () -> String?,
    private val fetch: () -> ByteArray = { fetchRelease() }
) {
    constructor(context: Context) : this(BuildConfig.VERSION_NAME, BuildConfig.DEBUG, { installerPackage(context) })

    // A null installer is normal for sideloads; an inspection failure must fail closed.
    private val enabled = !debug && try { installer() != "com.android.vending" } catch (_: Exception) { false }
    private var status = if (enabled) "idle" else "disabled"
    private var latestVersion: String? = null
    private var apkUrl: String? = null
    private var error: String? = null

    @Synchronized fun state(): JSONObject = JSONObject()
        .put("version", version).put("mode", if (enabled) "manual" else "disabled")
        .put("status", status).put("latestVersion", latestVersion ?: JSONObject.NULL)
        .put("progress", 0).put("error", error ?: JSONObject.NULL)

    @Synchronized fun beginCheck() {
        if (!enabled) return
        status = "checking"
        latestVersion = null
        apkUrl = null
        error = null
    }

    fun check(): JSONObject {
        if (!enabled) return state()
        beginCheck()
        // Do not hold the state monitor during network I/O or parsing: state/open run on the UI thread.
        val result = try {
            val bytes = fetch()
            check(bytes.size <= MAX_RESPONSE_BYTES)
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            val tokens = JSONTokener(text)
            val release = tokens.nextValue() as? JSONObject ?: error("Invalid release")
            check(tokens.nextClean() == '\u0000')
            check(release.get("draft") == false && release.get("prerelease") == false)
            val tag = release.get("tag_name") as? String ?: error("Invalid tag")
            check(tag.startsWith("v"))
            val latest = tag.substring(1)
            val candidate = numbers(latest)
            val installed = numbers(version)
            val newer = candidate.indices.firstOrNull { candidate[it] != installed[it] }
                ?.let { candidate[it] > installed[it] } ?: false
            val name = "sureneco_v${latest}_android.apk"
            val url = "https://github.com/sakots/sureneco/releases/download/v$latest/$name"
            val assets = release.getJSONArray("assets")
            var matches = 0
            for (index in 0 until assets.length()) {
                val asset = assets.getJSONObject(index)
                if (asset.opt("name") == name || asset.opt("browser_download_url") == url) {
                    check(asset.opt("name") == name && asset.opt("browser_download_url") == url)
                    matches++
                }
            }
            check(matches == 1)
            Result(if (newer) "available" else "current", latest, if (newer) url else null)
        } catch (_: Exception) {
            Result("error", null, null)
        }
        synchronized(this) {
            status = result.status
            latestVersion = result.latest
            apkUrl = result.url
            error = if (result.status == "error") CHECK_ERROR else null
        }
        return state()
    }

    @Synchronized fun open(activity: Activity) {
        check(enabled && status == "available") { "確認済みの更新がありません。" }
        val url = checkNotNull(apkUrl) { "確認済みの更新がありません。" }
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
    }

    private data class Result(val status: String, val latest: String?, val url: String?)

    companion object {
        private const val MAX_RESPONSE_BYTES = 262144
        private const val CHECK_ERROR = "更新を確認できませんでした。通信環境を確認して再試行してください。"
        private const val ENDPOINT = "https://api.github.com/repos/sakots/sureneco/releases/latest"
        // Manual update checks must not block notification registration/synchronization.
        val executor = Executors.newSingleThreadExecutor()
        private val VERSION = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

        private fun numbers(value: String): List<Int> {
            val match = VERSION.matchEntire(value) ?: error("Invalid version")
            return (1..3).map { match.groupValues[it].toInt() }
        }

        @Suppress("DEPRECATION")
        private fun installerPackage(context: Context): String? = if (Build.VERSION.SDK_INT >= 30) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            context.packageManager.getInstallerPackageName(context.packageName)
        }

        internal fun fetchRelease(open: () -> HttpsURLConnection = { URL(ENDPOINT).openConnection() as HttpsURLConnection }): ByteArray {
            val connection = open()
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 5000
                connection.readTimeout = 5000
                connection.requestMethod = "GET"
                connection.setRequestProperty("Accept", "application/vnd.github+json")
                connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                connection.setRequestProperty("User-Agent", "sureneco-android")
                check(connection.responseCode == 200)
                check(connection.contentLengthLong <= MAX_RESPONSE_BYTES)
                return connection.inputStream.use { stream ->
                    val result = ByteArrayOutputStream()
                    val buffer = ByteArray(4096)
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        check(result.size() + count <= MAX_RESPONSE_BYTES)
                        result.write(buffer, 0, count)
                    }
                    result.toByteArray()
                }
            } finally {
                connection.disconnect()
            }
        }
    }
}
