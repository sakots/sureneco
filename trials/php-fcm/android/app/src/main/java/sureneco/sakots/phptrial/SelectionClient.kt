package sureneco.sakots.phptrial

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

internal data class SelectionThread(val id: String, val title: String, val enabled: Boolean)

internal class SelectionHttpError(val status: Int) : IOException()

internal object SelectionClient {
    private val endpoint = URI("https://oekakibbs.moe/sureneco-php/selection.php").toURL()
    private val tokenPattern = Regex("[0-9a-f]{64}")
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

    fun load(bearer: String): List<SelectionThread> = parseThreads(request(bearer, null))

    fun save(bearer: String, id: String, enabled: Boolean): List<SelectionThread> {
        val body = JSONObject().put("id", id).put("enabled", enabled).toString()
        val snapshot = parseThreads(request(bearer, body))
        if (snapshot.none { it.id == id && it.enabled == enabled }) throw IOException()
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

    private fun parseThreads(document: JSONObject): List<SelectionThread> {
        val threads = document.getJSONArray("threads")
        val ids = HashSet<String>()
        return List(threads.length()) { index ->
            val thread = threads.getJSONObject(index)
            val id = thread.get("id") as? String ?: throw IOException()
            val title = thread.get("title") as? String ?: throw IOException()
            val enabled = thread.get("enabled") as? Boolean ?: throw IOException()
            if (id.isEmpty() || !ids.add(id)) throw IOException()
            SelectionThread(id, title, enabled)
        }
    }
}
