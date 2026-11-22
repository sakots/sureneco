package sureneco.sakots.phptrial

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

internal data class SelectionThread(val id: String, val title: String, val enabled: Boolean)
internal data class TrialRecruitment(
    val threadId: String,
    val number: Int,
    val body: String,
    val roomIds: List<String>,
    val postedAt: Long,
    val expiresAt: Long,
)
internal data class MonitoringSettings(val threadRefreshSec: Int, val filter: String) {
    companion object {
        val refreshRange = 60..86_400
        val filters = listOf("regex", "loose")
    }
}
internal data class MonitoringSnapshot(
    val threads: List<SelectionThread>,
    val recruitments: List<TrialRecruitment>,
    val settings: MonitoringSettings,
)

internal class SelectionHttpError(val status: Int) : IOException()

internal object SelectionClient {
    private val endpoint = URI("https://oekakibbs.moe/sureneco-php/selection.php").toURL()
    private val tokenPattern = Regex("[0-9a-f]{64}")
    private val threadIdPattern = Regex("[0-9]{9,11}")
    private val roomIdPattern = Regex("[0-9]{5}")
    private val proofDomain = "sureneco-php-selection-v1:".toByteArray(Charsets.UTF_8)
    private const val HEX = "0123456789abcdef"

    internal fun exchangeBody(registrationToken: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(proofDomain)
        val hash = digest.digest(registrationToken.toByteArray(Charsets.UTF_8))
        return buildString(88) {
            append("{\"registrationProof\":\"")
            for (byte in hash) {
                val value = byte.toInt() and 0xff
                append(HEX[value ushr 4])
                append(HEX[value and 0xf])
            }
            append("\"}")
        }
    }

    internal fun parseBearer(value: Any?): String? = (value as? String)?.takeIf(tokenPattern::matches)

    fun exchange(registrationToken: String): String =
        parseBearer(request(null, exchangeBody(registrationToken)).opt("token")) ?: throw IOException()

    fun load(bearer: String): MonitoringSnapshot = parseSnapshot(request(bearer, null))

    fun save(bearer: String, id: String, enabled: Boolean): MonitoringSnapshot {
        val body = JSONObject().put("id", id).put("enabled", enabled)
        val snapshot = parseSnapshot(request(bearer, body.toString()))
        if (snapshot.threads.none { it.id == id && it.enabled == enabled }) throw IOException()
        return snapshot
    }

    fun saveSettings(bearer: String, settings: MonitoringSettings): MonitoringSnapshot {
        val values = JSONObject()
            .put("thread_refresh_sec", settings.threadRefreshSec)
            .put("recruitment_filter", settings.filter)
        val body = JSONObject().put("settings", values)
        val snapshot = parseSnapshot(request(bearer, body.toString()))
        if (snapshot.settings != settings) throw IOException()
        return snapshot
    }

    private fun request(bearer: String?, body: String?): JSONObject {
        val connection = endpoint.openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            connection.requestMethod = if (body == null) "GET" else "POST"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer $bearer")
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) throw SelectionHttpError(status)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        } finally {
            connection.disconnect()
        }
    }

    private fun parseSnapshot(document: JSONObject): MonitoringSnapshot {
        val threads = document.getJSONArray("threads")
        val ids = HashSet<String>()
        val parsedThreads = List(threads.length()) { index ->
            val thread = threads.getJSONObject(index)
            val id = thread.getThreadId("id")
            val title = thread.get("title") as? String ?: throw IOException()
            val enabled = thread.get("enabled") as? Boolean ?: throw IOException()
            if (!ids.add(id)) throw IOException()
            SelectionThread(id, title, enabled)
        }
        val recruitments = document.getJSONArray("recruitments")
        val parsedRecruitments = List(recruitments.length()) { index ->
            val item = recruitments.getJSONObject(index)
            val rooms = item.getJSONArray("roomIds")
            val roomIds = List(rooms.length()) { roomIndex ->
                (rooms.get(roomIndex) as? String)?.takeIf(roomIdPattern::matches) ?: throw IOException()
            }
            TrialRecruitment(
                item.getThreadId("threadId"),
                (item.get("number") as? Int)?.takeIf { it > 0 } ?: throw IOException(),
                item.get("body") as? String ?: throw IOException(),
                roomIds,
                item.getTimestamp("postedAt"),
                item.getTimestamp("expiresAt"),
            )
        }
        val settings = document.getJSONObject("settings")
        val refresh = settings.get("thread_refresh_sec") as? Int ?: throw IOException()
        val filter = settings.get("recruitment_filter") as? String ?: throw IOException()
        if (refresh !in MonitoringSettings.refreshRange || filter !in MonitoringSettings.filters) throw IOException()
        return MonitoringSnapshot(parsedThreads, parsedRecruitments, MonitoringSettings(refresh, filter))
    }

    private fun JSONObject.getThreadId(key: String): String =
        (get(key) as? String)?.takeIf(threadIdPattern::matches) ?: throw IOException()

    private fun JSONObject.getTimestamp(key: String): Long = when (val value = get(key)) {
        is Long -> value
        is Int -> value.toLong()
        else -> throw IOException()
    }
}
