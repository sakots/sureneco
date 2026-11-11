package sureneco.sakots.phptrial

import org.junit.Assert.*
import org.junit.Test

class ReceiptPolicyTest {
    private val now = 1_800_000_000L
    private val id = "0123456789abcdef0123456789abcdef"
    private fun payload() = mapOf(
        "type" to "connectivity_test", "eventId" to id,
        "sentAt" to (now - 10).toString(), "expiresAt" to (now + 290).toString(),
        "title" to "接続試験", "body" to "FCM を受信しました。"
    )

    @Test fun acceptsOnlyUnseenValidEnabledReceipt() {
        val result = ReceiptPolicy.evaluate(payload(), now, true, emptySet())
        assertEquals(ReceiptPolicy.Reason.ACCEPTED, result.reason)
        assertEquals(id, result.payload?.eventId)
    }

    @Test fun stoppedReceiverCannotAcceptEvenValidMessage() {
        assertEquals(ReceiptPolicy.Reason.STOPPED, ReceiptPolicy.evaluate(payload(), now, false, emptySet()).reason)
    }

    @Test fun duplicateDoesNotProduceAnotherNotification() {
        assertEquals(ReceiptPolicy.Reason.DUPLICATE, ReceiptPolicy.evaluate(payload(), now, true, setOf(id)).reason)
    }

    @Test fun rejectsExpiredAndImpossibleLifetime() {
        val expired = payload() + mapOf("sentAt" to (now - 300).toString(), "expiresAt" to now.toString())
        assertEquals(ReceiptPolicy.Reason.EXPIRED, ReceiptPolicy.evaluate(expired, now, true, emptySet()).reason)
        for (change in listOf(
            mapOf("expiresAt" to (now + 301).toString()),
            mapOf("sentAt" to (now + 1).toString(), "expiresAt" to (now + 301).toString())
        )) assertEquals(ReceiptPolicy.Reason.MALFORMED, ReceiptPolicy.evaluate(payload() + change, now, true, emptySet()).reason)
    }

    @Test fun rejectsWrongKindIdsTimestampsAndUnexpectedFields() {
        val changes = listOf(
            mapOf("type" to "notification"), mapOf("eventId" to id.uppercase()),
            mapOf("eventId" to "short"), mapOf("sentAt" to "+1800000000"),
            mapOf("sentAt" to "999999999999999999999999"), mapOf("extra" to "unexpected")
        )
        for (change in changes) assertEquals(change.toString(), ReceiptPolicy.Reason.MALFORMED,
            ReceiptPolicy.evaluate(payload() + change, now, true, emptySet()).reason)
        assertEquals(ReceiptPolicy.Reason.MALFORMED, ReceiptPolicy.evaluate(payload() - "body", now, true, emptySet()).reason)
    }

    @Test fun boundsTextByUnicodeCharactersAndPayloadBytes() {
        assertEquals(ReceiptPolicy.Reason.MALFORMED, ReceiptPolicy.evaluate(payload() + ("title" to "a".repeat(81)), now, true, emptySet()).reason)
        assertEquals(ReceiptPolicy.Reason.MALFORMED, ReceiptPolicy.evaluate(payload() + ("body" to "a".repeat(221)), now, true, emptySet()).reason)
        val emoji = String(Character.toChars(0x1f408))
        assertEquals(ReceiptPolicy.Reason.ACCEPTED, ReceiptPolicy.evaluate(payload() + ("title" to emoji.repeat(80)), now, true, emptySet()).reason)
        assertEquals(ReceiptPolicy.Reason.MALFORMED, ReceiptPolicy.evaluate(payload() + ("body" to ""), now, true, emptySet()).reason)
    }
}
