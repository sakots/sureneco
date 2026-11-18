package sureneco.sakots

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
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
    private val fetch: (Int) -> ByteArray = { page -> fetchRelease(page) }
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
            var totalBytes = 0
            var page = 1
            var selected: JSONObject? = null
            var latest: String? = null
            var selectedNumbers: List<Int>? = null
            while (true) {
                val bytes = fetch(page)
                check(bytes.size <= MAX_RESPONSE_BYTES)
                totalBytes += bytes.size
                check(totalBytes <= MAX_TOTAL_BYTES)
                val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
                val tokens = JSONTokener(text)
                val releases = tokens.nextValue() as? JSONArray ?: error("Invalid releases")
                check(tokens.nextClean() == '\u0000')
                check(releases.length() <= PAGE_SIZE)
                for (index in 0 until releases.length()) {
                    val release = releases.getJSONObject(index)
                    if (release.opt("draft") != false || release.opt("prerelease") != false) continue
                    val tag = release.opt("tag_name") as? String ?: continue
                    if (!tag.startsWith("v")) continue
                    val candidate = tag.substring(1)
                    val candidateNumbers = try { numbers(candidate) } catch (_: Exception) { continue }
                    val assets = release.getJSONArray("assets")
                    val url = apkUrl(candidate)
                    var hasApk = false
                    for (assetIndex in 0 until assets.length()) {
                        if (isApk(assets.getJSONObject(assetIndex), url)) hasApk = true
                    }
                    if (hasApk && (selectedNumbers == null || compare(candidateNumbers, selectedNumbers) > 0)) {
                        selected = release
                        latest = candidate
                        selectedNumbers = candidateNumbers
                    }
                }
                // Ignore untrusted Link URLs. Only fixed-origin, sequential page numbers are used.
                if (releases.length() < PAGE_SIZE) break
                check(page < MAX_PAGES)
                page++
            }
            if (selected == null) {
                Result("current", null, null)
            } else {
                val latestVersion = checkNotNull(latest)
                val name = "sureneco_v${latestVersion}_android.apk"
                val url = apkUrl(latestVersion)
                val assets = selected.getJSONArray("assets")
                var matches = 0
                // Validate only after choosing the newest Android release; never hide it behind an older valid APK.
                for (index in 0 until assets.length()) {
                    val asset = assets.getJSONObject(index)
                    if (isApk(asset, url)) {
                        check(asset.opt("name") == name && asset.opt("browser_download_url") == url)
                        matches++
                    }
                }
                check(matches == 1)
                val newer = compare(checkNotNull(selectedNumbers), numbers(version)) > 0
                Result(if (newer) "available" else "current", latestVersion, if (newer) url else null)
            }
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
        private const val PAGE_SIZE = 10
        private const val MAX_PAGES = 10
        private const val MAX_RESPONSE_BYTES = 262144
        private const val MAX_TOTAL_BYTES = 1048576
        private const val CONNECT_TIMEOUT_MS = 5000
        private const val READ_TIMEOUT_MS = 5000
        private const val CHECK_ERROR = "更新を確認できませんでした。通信環境を確認して再試行してください。"
        private const val ENDPOINT = "https://api.github.com/repos/sakots/sureneco/releases"
        // Manual update checks must not block notification registration/synchronization.
        val executor = Executors.newSingleThreadExecutor()
        private val VERSION = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

        private fun numbers(value: String): List<Int> {
            val match = VERSION.matchEntire(value) ?: error("Invalid version")
            return (1..3).map { match.groupValues[it].toInt() }
        }

        private fun compare(left: List<Int>, right: List<Int>): Int {
            for (index in 0..2) {
                val result = left[index].compareTo(right[index])
                if (result != 0) return result
            }
            return 0
        }

        private fun apkUrl(version: String) =
            "https://github.com/sakots/sureneco/releases/download/v$version/sureneco_v${version}_android.apk"

        private fun isApk(asset: JSONObject, canonicalUrl: String): Boolean =
            (asset.opt("name") as? String)?.endsWith(".apk") == true || asset.opt("browser_download_url") == canonicalUrl

        @Suppress("DEPRECATION")
        private fun installerPackage(context: Context): String? = if (Build.VERSION.SDK_INT >= 30) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            context.packageManager.getInstallerPackageName(context.packageName)
        }

        internal fun fetchRelease(page: Int, open: (URL) -> HttpsURLConnection = {
            it.openConnection() as HttpsURLConnection
        }): ByteArray {
            check(page in 1..MAX_PAGES)
            val connection = open(URL("$ENDPOINT?per_page=$PAGE_SIZE&page=$page"))
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
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
