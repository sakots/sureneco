package sureneco.sakots.phptrial

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class SelectionCredentialsTest {
    @Test fun exchangeBodyContainsOnlyTheDomainSeparatedProofOfTheExactUtf8Token() {
        val registrationToken = " FCM-登録 "
        val body = SelectionClient.exchangeBody(registrationToken)
        assertEquals(
            """{"registrationProof":"1d474721c93534819df19254ccda904322699f3a0d5356a2d57b12741b341824"}""",
            body
        )
        assertFalse(body.contains(registrationToken))
    }

    @Test fun exchangedBearerRequiresExactly64LowercaseHexCharacters() {
        val token = "a0".repeat(32)
        assertEquals(token, SelectionClient.parseBearer(token))
        for (invalid in listOf(null, 42, token.dropLast(1), token + "0", token.uppercase(), "g" + token.drop(1), "$token\n")) {
            assertNull(SelectionClient.parseBearer(invalid))
        }
    }
}
