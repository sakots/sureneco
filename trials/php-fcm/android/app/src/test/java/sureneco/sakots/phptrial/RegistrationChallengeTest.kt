package sureneco.sakots.phptrial

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RegistrationChallengeTest {
    private val id = "a".repeat(32)
    private val code = "b".repeat(64)
    private val payload = mapOf(
        "type" to "registration_challenge", "challengeId" to id,
        "code" to code, "expiresAt" to "1100",
    )

    @Test fun onlyCurrentWellFormedChallengesAreAccepted() {
        assertEquals(id, RegistrationChallenge.parse(payload, 1000)?.id)
        assertNull(RegistrationChallenge.parse(payload, 1100))
        assertNull(RegistrationChallenge.parse(payload + ("challengeId" to id.uppercase()), 1000))
        assertNull(RegistrationChallenge.parse(payload + ("code" to code.dropLast(1)), 1000))
        assertNull(RegistrationChallenge.parse(payload + ("type" to "recruitment"), 1000))
    }
}
