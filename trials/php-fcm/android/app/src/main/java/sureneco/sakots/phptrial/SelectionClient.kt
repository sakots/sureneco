package sureneco.sakots.phptrial

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URISyntaxException
import javax.net.ssl.HttpsURLConnection

internal class SelectionCredentials private constructor(val endpoint: URI, val token: String) {
    companion object {
        private val tokenPattern = Regex("[0-9a-f]{64}")

        fun parse(endpoint: String, token: String): SelectionCredentials? {
            if (!tokenPattern.matches(token)) return null
            val uri = try {
                URI(endpoint.trim())
            } catch (_: URISyntaxException) {
                return null
            }
            return if (uri.scheme.equals("https", ignoreCase = true) && uri.host != null &&
                uri.rawUserInfo == null && uri.rawFragment == null &&
                (uri.port == -1 || uri.port in 1..65535)
            ) SelectionCredentials(uri, token) else null
        }
    }
}

internal data class SelectionThread(val id: String, val title: String, val enabled: Boolean)

internal class SelectionHttpError(val status: Int) : IOException()

internal object SelectionClient {
    fun load(credentials: SelectionCredentials): List<SelectionThread> = request(credentials, null)

    fun save(credentials: SelectionCredentials, id: String, enabled: Boolean): List<SelectionThread> {
        val snapshot = request(credentials, JSONObject().put("id", id).put("enabled", enabled))
        if (snapshot.none { it.id == id && it.enabled == enabled }) throw IOException()
        return snapshot
    }

    private fun request(credentials: SelectionCredentials, body: JSONObject?): List<SelectionThread> {
        val connection = credentials.endpoint.toURL().openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            connection.requestMethod = if (body == null) "GET" else "POST"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer ${credentials.token}")
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) throw SelectionHttpError(status)
            val document = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val threads = JSONObject(document).getJSONArray("threads")
            val ids = HashSet<String>()
            return List(threads.length()) { index ->
                val thread = threads.getJSONObject(index)
                val id = thread.get("id") as? String ?: throw IOException()
                val title = thread.get("title") as? String ?: throw IOException()
                val enabled = thread.get("enabled") as? Boolean ?: throw IOException()
                if (id.isEmpty() || !ids.add(id)) throw IOException()
                SelectionThread(id, title, enabled)
            }
        } finally {
            connection.disconnect()
        }
    }
}
