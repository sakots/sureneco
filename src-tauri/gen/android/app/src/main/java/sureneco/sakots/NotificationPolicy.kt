package sureneco.sakots

/** Pure receive policy, independent of Activity/WebView lifetime. */
object NotificationPolicy {
    fun accepts(enabled: Boolean, permission: Boolean, decrypted: Boolean, revision: Long,
                expectedRevision: Long, generation: String, expectedGeneration: String,
                expires: Long, now: Long, seen: Boolean): Boolean =
        enabled && permission && decrypted && expectedRevision > 0 && revision == expectedRevision &&
        generation.isNotEmpty() && generation == expectedGeneration && expires > now && !seen
}
