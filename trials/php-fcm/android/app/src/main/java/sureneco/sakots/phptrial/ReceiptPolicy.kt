package sureneco.sakots.phptrial

/** Pure policy; the caller serializes evaluation, durable dedupe, and notification. */
object ReceiptPolicy {
    enum class Reason { ACCEPTED, STOPPED, MALFORMED, EXPIRED, DUPLICATE }
    data class Payload(val eventId: String, val expiresAt: Long, val title: String, val body: String)
    data class Decision(val reason: Reason, val payload: Payload? = null)
    private val keys = setOf("type", "eventId", "sentAt", "expiresAt", "title", "body")
    private val eventIdPattern = Regex("[a-f0-9]{32}")
    private val timestampPattern = Regex("[0-9]{1,12}")

    fun evaluate(data: Map<String, String>, now: Long, enabled: Boolean, seen: Set<String>): Decision {
        if (!enabled) return Decision(Reason.STOPPED)
        if (data.keys != keys || data["type"] != "connectivity_test") return Decision(Reason.MALFORMED)
        // Bound strings before encoding/counting them, including hostile oversized input.
        if (data.any { it.key.length > 32 || it.value.length > 1024 } ||
            data.entries.sumOf { it.key.toByteArray(Charsets.UTF_8).size + it.value.toByteArray(Charsets.UTF_8).size } > 2048
        ) return Decision(Reason.MALFORMED)
        val id = data.getValue("eventId")
        val sentText = data.getValue("sentAt")
        val expiresText = data.getValue("expiresAt")
        val title = data.getValue("title")
        val body = data.getValue("body")
        if (!eventIdPattern.matches(id) || !timestampPattern.matches(sentText) || !timestampPattern.matches(expiresText) ||
            title.isBlank() || body.isBlank() || title.codePointCount(0, title.length) > 80 || body.codePointCount(0, body.length) > 220
        ) return Decision(Reason.MALFORMED)
        val sentAt = sentText.toLong()
        val expiresAt = expiresText.toLong()
        if (expiresAt - sentAt != 300L || sentAt > now) return Decision(Reason.MALFORMED)
        if (expiresAt <= now) return Decision(Reason.EXPIRED)
        if (id in seen) return Decision(Reason.DUPLICATE)
        return Decision(Reason.ACCEPTED, Payload(id, expiresAt, title, body))
    }
}
