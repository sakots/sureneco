package sureneco.sakots

import org.junit.Assert.*
import org.junit.Test

class PushRegistrationLifecycleTest {
    private val issued = NtfyRegistration("upOne", "sur_device", "private-password", "pending", null)

    private class Fixture(initial: PushRegistrationLifecycle.State) : PushRegistrationLifecycle.Port {
        var current = initial
        val calls = mutableListOf<String>()
        var response: NtfyRegistration? = null
        var duringRequest: (() -> Unit)? = null
        var fail = false
        var rotationResponseLost = false
        override fun state() = current
        override fun apply(expected: PushRegistrationLifecycle.State, change: PushRegistrationLifecycle.Change): Boolean {
            if (!PushRegistrationLifecycle.sameOperation(expected, current)) return false
            current = PushRegistrationLifecycle.transition(current, change)
            return true
        }
        private fun request(name: String) {
            calls.add(name)
            duringRequest?.also { duringRequest = null; it() }
            if (fail) error("offline")
        }
        override fun putRegistration(token: String, topic: String): NtfyRegistration? { request("PUT registration $topic"); return response }
        override fun getRegistration(token: String): NtfyRegistration? { request("GET registration"); return response }
        override fun stopSubscription(token: String) { request("POST stop") }
        override fun deleteDevice(token: String) { request("DELETE device $token") }
        override fun issueDevice(): String { request("POST device"); return "issued-token" }
        override fun newToken() = "next-token"
        override fun rotateDevice(token: String, next: String) {
            request("POST rotate $token")
            if (rotationResponseLost) error("response lost")
        }
        override fun probeDevice(token: String) { request("GET subscription $token") }
        override fun retainCleanupToken(token: String) { current = current.copy(cleanupToken = token) }
        val lifecycle = PushRegistrationLifecycle(this)
    }

    private fun active() = PushRegistrationLifecycle.State(epoch = 1, enabled = true, token = "device-token", topic = "upOne")

    @Test fun putsValidatedTopicAndPollsBeforeAllowingSubscription() {
        val f = Fixture(active())
        f.response = issued
        assertNull(f.lifecycle.sync())
        assertEquals(listOf("PUT registration upOne"), f.calls)
        assertEquals("private-password", f.current.registration?.password)
        assertNull(f.lifecycle.sync())
        assertEquals("GET registration", f.calls.last())
        f.response = issued.copy(state = "ready")
        val ready = f.lifecycle.sync()
        assertEquals(1L, ready?.epoch)
        assertEquals("device-token", ready?.token)
        assertEquals("ready", f.current.registration?.state)
    }

    @Test fun endpointChangeOrSettingsEpochRejectsOldCredentials() {
        for (change in listOf<(PushRegistrationLifecycle.State) -> PushRegistrationLifecycle.State>(
            { it.copy(epoch = 2, topic = "upOther") },
            { it.copy(epoch = 2) }
        )) {
            val f = Fixture(active())
            f.response = issued.copy(state = "ready")
            f.duringRequest = { f.current = change(f.current) }
            assertNull(f.lifecycle.sync())
            assertNull(f.current.registration)
            assertEquals(-1L, f.current.registrationEpoch)
        }
    }

    @Test fun stopOrDeleteDuringPutCannotRestoreCredentialsOrSubscribe() {
        for (action in listOf("stop", "delete")) {
            val f = Fixture(active())
            f.response = issued.copy(state = "ready")
            f.duringRequest = { f.current = f.current.copy(epoch = 2, enabled = false, pendingAction = action) }
            assertNull(f.lifecycle.sync())
            assertNull(f.current.registration)
            assertEquals(action, f.current.pendingAction)
            assertEquals(1, f.calls.size)
        }
    }

    @Test fun stopFailureRemainsLocallySuppressedAndRetryDistinguishesAcceptanceFromAclCompletion() {
        val f = Fixture(active().copy(epoch = 2, enabled = false, pendingAction = "stop", registration = issued.copy(state = "ready")))
        f.fail = true
        try { f.lifecycle.sync(); fail("stop should report offline") } catch (_: IllegalStateException) { }
        assertFalse(f.current.enabled)
        assertEquals("stop", f.current.pendingAction)
        f.fail = false
        f.response = issued
        assertNull(f.lifecycle.sync())
        assertNull(f.current.pendingAction)
        assertTrue(f.current.stopAwaiting)
        assertEquals("pending", f.current.registration?.state)
        assertEquals("停止受付済み：ntfy権限撤去待ち", f.current.status)
        f.calls.clear()
        f.response = issued.copy(state = "stopped")
        assertNull(f.lifecycle.sync())
        assertEquals(listOf("GET registration"), f.calls)
        assertFalse(f.current.stopAwaiting)
        assertEquals("停止完了：ntfy権限撤去済み", f.current.status)
    }

    @Test fun stopAcceptanceSurvivesRegistrationGetFailure() {
        val f = Fixture(active().copy(enabled = false, pendingAction = "stop"))
        f.duringRequest = { f.fail = true }
        try { f.lifecycle.sync() } catch (_: IllegalStateException) { }
        assertEquals("stop", f.current.pendingAction)
        f.fail = false
        f.duringRequest = { f.duringRequest = { f.fail = true } }
        try { f.lifecycle.sync(); fail("GET should report offline") } catch (_: IllegalStateException) { }
        assertNull(f.current.pendingAction)
        assertTrue(f.current.stopAwaiting)
    }

    @Test fun deleteRetriesAllPossibleTokensAndClearsSecretsOnlyAfterAcceptance() {
        val f = Fixture(active().copy(enabled = false, pendingAction = "delete", nextToken = "rotated-token", registration = issued))
        f.fail = true
        try { f.lifecycle.sync(); fail("delete should report offline") } catch (_: IllegalStateException) { }
        assertEquals("device-token", f.current.token)
        assertEquals("delete", f.current.pendingAction)
        f.fail = false
        f.calls.clear()
        assertNull(f.lifecycle.sync())
        assertEquals(listOf("DELETE device device-token", "DELETE device rotated-token"), f.calls)
        assertNull(f.current.token)
        assertNull(f.current.nextToken)
        assertNull(f.current.registration)
        assertNull(f.current.pendingAction)
        assertEquals("端末削除受付済み（ntfy権限撤去は非同期）", f.current.status)
    }

    @Test fun staleDeleteResponseCannotClearNewerOperation() {
        val f = Fixture(active().copy(enabled = false, pendingAction = "delete"))
        f.duringRequest = { f.current = f.current.copy(epoch = 2) }
        assertNull(f.lifecycle.sync())
        assertEquals("device-token", f.current.token)
        assertEquals("delete", f.current.pendingAction)
    }

    @Test fun resumeReissuesSameTopicRatherThanTrustingPreStopReadyCredentials() {
        val f = Fixture(active().copy(epoch = 3, registrationEpoch = 1, registration = issued.copy(state = "ready")))
        f.response = issued
        assertNull(f.lifecycle.sync())
        assertEquals(listOf("PUT registration upOne"), f.calls)
        assertEquals(issued.password, f.current.registration?.password)
        assertEquals(3L, f.current.registrationEpoch)
    }

    @Test fun unavailableOrMissingRegistrationNeverAllowsLegacySubscription() {
        val f = Fixture(active())
        f.fail = true
        try { f.lifecycle.sync(); fail("API failure must surface") } catch (_: IllegalStateException) { }
        f.fail = false
        try { f.lifecycle.sync(); fail("missing managed registration must fail closed") } catch (_: IllegalStateException) { }
        assertNull(f.current.registration)
    }

    @Test fun unexpectedTopicResponseIsRejectedWithoutSavingCredentials() {
        val f = Fixture(active())
        f.response = issued.copy(topic = "upOther", state = "ready")
        try { f.lifecycle.sync(); fail("wrong topic must fail closed") } catch (_: IllegalStateException) { }
        assertNull(f.current.registration)
    }

    @Test fun staleIssuedTokenIsDeletedBeforeAnyNewProvisioning() {
        val f = Fixture(active().copy(cleanupToken = "stale-created-token"))
        f.response = issued
        assertNull(f.lifecycle.sync())
        assertEquals(listOf("DELETE device stale-created-token", "PUT registration upOne"), f.calls)
        assertNull(f.current.cleanupToken)
    }

    @Test fun firstRunIssuesTokenAndFailedIssuanceCanBeRetriedWithoutLosingDesiredState() {
        val f = Fixture(active().copy(token = null))
        f.fail = true
        try { f.lifecycle.prepareCredentials(false); fail("issuance should fail") } catch (_: IllegalStateException) { }
        assertTrue(f.current.enabled)
        assertNull(f.current.token)
        f.fail = false
        assertTrue(f.lifecycle.prepareCredentials(false))
        assertEquals("issued-token", f.current.token)
        assertEquals(listOf("POST device", "POST device"), f.calls)
    }

    @Test fun stopOrDeleteDuringIssuanceNeverInstallsTheReturnedCredential() {
        for (action in listOf("stop", "delete")) {
            val f = Fixture(active().copy(token = null))
            f.duringRequest = { f.current = f.current.copy(epoch = 2, enabled = false, pendingAction = action) }
            assertFalse(f.lifecycle.prepareCredentials(false))
            assertNull(f.current.token)
            assertNull(f.current.cleanupToken)
            assertEquals(action, f.current.pendingAction)
            assertEquals(listOf("POST device", "DELETE device issued-token"), f.calls)
        }
    }

    @Test fun staleIssuanceCleanupFailureKeepsOnlyCleanupCredentialForRetry() {
        val f = Fixture(active().copy(token = null))
        f.duringRequest = {
            f.current = f.current.copy(epoch = 2, enabled = false, pendingAction = "delete")
            f.duringRequest = { f.fail = true }
        }
        try { f.lifecycle.prepareCredentials(false); fail("cleanup should report offline") } catch (_: IllegalStateException) { }
        assertNull(f.current.token)
        assertEquals("issued-token", f.current.cleanupToken)
        f.fail = false
        f.lifecycle.sync()
        assertNull(f.current.cleanupToken)
        assertNull(f.current.pendingAction)
    }

    @Test fun deleteDuringRotationKeepsBothPossibleTokensWithoutApplyingStaleResponse() {
        val f = Fixture(active())
        f.duringRequest = { f.current = f.current.copy(epoch = 2, enabled = false, pendingAction = "delete") }
        assertFalse(f.lifecycle.prepareCredentials(true))
        assertEquals("device-token", f.current.token)
        assertEquals("next-token", f.current.nextToken)
        f.calls.clear()
        f.lifecycle.sync()
        assertEquals(listOf("DELETE device device-token", "DELETE device next-token"), f.calls)
        assertNull(f.current.token)
        assertNull(f.current.nextToken)
    }

    @Test fun lostRotationResponseIsRecoveredWithNewTokenWithoutDiscardingAuthentication() {
        val f = Fixture(active())
        f.rotationResponseLost = true
        assertTrue(f.lifecycle.prepareCredentials(true))
        assertEquals(listOf("POST rotate device-token", "GET subscription next-token"), f.calls)
        assertEquals("next-token", f.current.token)
        assertNull(f.current.nextToken)
    }

    @Test fun stopDuringRotationCanRecoverThenStopWithoutReprovisioning() {
        val f = Fixture(active())
        f.duringRequest = { f.current = f.current.copy(epoch = 2, enabled = false, pendingAction = "stop") }
        assertFalse(f.lifecycle.prepareCredentials(true))
        f.rotationResponseLost = true
        f.response = issued.copy(state = "stopped")
        f.calls.clear()
        f.lifecycle.sync()
        assertEquals(listOf("POST rotate device-token", "GET subscription next-token", "POST stop", "GET registration"), f.calls)
        assertFalse(f.current.stopAwaiting)
        assertEquals("next-token", f.current.token)
    }

    @Test fun tokenChangeDuringRegistrationGetRejectsTheOldResponse() {
        val f = Fixture(active().copy(registration = issued, registrationEpoch = 1))
        f.response = issued.copy(state = "ready")
        f.duringRequest = { f.current = f.current.copy(token = "different-token") }
        assertNull(f.lifecycle.sync())
        assertEquals("pending", f.current.registration?.state)
    }

    @Test fun cachedReadyCredentialsStillRequireTheAuthenticatedApiOnRetry() {
        val f = Fixture(active().copy(registration = issued.copy(state = "ready"), registrationEpoch = 1))
        f.fail = true
        try { f.lifecycle.sync(); fail("cached credentials must not silently bypass the API") } catch (_: IllegalStateException) { }
        assertEquals(listOf("GET registration"), f.calls)
        assertEquals("device-token", f.current.token)
    }

    @Test fun stalePrepareAndPendingDeleteNeverIssueOrRotateCredentials() {
        val stale = Fixture(active().copy(epoch = 2, token = null))
        assertFalse(stale.lifecycle.prepareCredentials(true, expected = 1))
        assertTrue(stale.calls.isEmpty())
        val deleting = Fixture(active().copy(enabled = false, pendingAction = "delete"))
        assertFalse(deleting.lifecycle.prepareCredentials(true))
        assertTrue(deleting.calls.isEmpty())
        assertFalse(deleting.current.enabled)
        assertEquals("delete", deleting.current.pendingAction)
    }

    @Test fun foregroundCadenceIsBoundedButExplicitRetryCanProceedImmediately() {
        assertTrue(PushRegistrationLifecycle.pollDue(10_000, 0, 5_000))
        assertFalse(PushRegistrationLifecycle.pollDue(14_999, 10_000, 5_000))
        assertTrue(PushRegistrationLifecycle.pollDue(15_000, 10_000, 5_000))
        assertTrue(PushRegistrationLifecycle.pollDue(1_000, 10_000, 5_000))
    }
}
