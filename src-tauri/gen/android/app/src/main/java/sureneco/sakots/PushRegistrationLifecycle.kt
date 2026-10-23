package sureneco.sakots

/** The server returns these credentials only to the authenticated device. Never log this value. */
class NtfyRegistration(val topic: String, val username: String, val password: String, val state: String, val error: String?) {
    fun copy(topic: String = this.topic, username: String = this.username, password: String = this.password,
             state: String = this.state, error: String? = this.error) = NtfyRegistration(topic, username, password, state, error)
}

/** Network orchestration shared by the private-preference adapter and ordinary JVM tests. */
class PushRegistrationLifecycle(private val port: Port) {
    class State(
        val epoch: Long,
        val enabled: Boolean,
        val pendingAction: String? = null,
        val stopAwaiting: Boolean = false,
        val token: String? = null,
        val nextToken: String? = null,
        val cleanupToken: String? = null,
        val topic: String? = null,
        val registration: NtfyRegistration? = null,
        val registrationEpoch: Long = -1,
        val status: String = "未登録"
    ) {
        fun copy(epoch: Long = this.epoch, enabled: Boolean = this.enabled, pendingAction: String? = this.pendingAction,
                 stopAwaiting: Boolean = this.stopAwaiting, token: String? = this.token, nextToken: String? = this.nextToken,
                 cleanupToken: String? = this.cleanupToken, topic: String? = this.topic,
                 registration: NtfyRegistration? = this.registration, registrationEpoch: Long = this.registrationEpoch,
                 status: String = this.status) = State(epoch, enabled, pendingAction, stopAwaiting, token, nextToken,
                     cleanupToken, topic, registration, registrationEpoch, status)
    }
    sealed class Change {
        class Registration(val value: NtfyRegistration) : Change()
        object StopAccepted : Change()
        class StopObserved(val value: NtfyRegistration?) : Change()
        object Deleted : Change()
        object CleanupComplete : Change()
        class TokenIssued(val token: String) : Change()
        class RotationStarted(val token: String) : Change()
        class Rotated(val token: String) : Change()
    }
    class Ready(val epoch: Long, val token: String)
    interface Port {
        fun state(): State
        fun apply(expected: State, change: Change): Boolean
        fun putRegistration(token: String, topic: String): NtfyRegistration?
        fun getRegistration(token: String): NtfyRegistration?
        fun stopSubscription(token: String)
        fun deleteDevice(token: String)
        fun issueDevice(): String
        fun newToken(): String
        fun rotateDevice(token: String, next: String)
        fun probeDevice(token: String)
        fun retainCleanupToken(token: String)
    }

    private fun current(expected: State) = sameOperation(expected, port.state())

    private fun cleanup(state: State): State? {
        state.cleanupToken?.let {
            if (!current(state)) return null
            port.deleteDevice(it)
            if (!port.apply(state, Change.CleanupComplete)) return null
        }
        return port.state().takeIf { it.epoch == state.epoch }
    }

    fun prepareCredentials(shouldRotate: Boolean, expected: Long = port.state().epoch): Boolean {
        var state = port.state()
        if (state.epoch != expected || !state.enabled || state.pendingAction != null) return false
        state = cleanup(state) ?: return false
        if (!current(state)) return false
        if (state.token == null) {
            val token = port.issueDevice()
            if (!port.apply(state, Change.TokenIssued(token))) {
                // A stop/delete won the race. This token can only be used to remove the orphan device.
                port.retainCleanupToken(token)
                cleanup(port.state())
                return false
            }
            state = port.state()
        }
        if ((shouldRotate || state.nextToken != null) && !recoverRotation(state.epoch)) return false
        val latest = port.state()
        return latest.epoch == state.epoch && latest.enabled && latest.pendingAction == null
    }

    private fun recoverRotation(expected: Long): Boolean {
        var state = port.state()
        if (state.epoch != expected || state.pendingAction == "delete") return false
        val token = state.token ?: return false
        val next = state.nextToken ?: port.newToken()
        if (!port.apply(state, Change.RotationStarted(next))) return false
        state = port.state()
        if (!current(state)) return false
        try {
            port.rotateDevice(token, next)
        } catch (_: Exception) {
            if (!current(state)) return false
            // Recover a lost response without discarding either possible bearer credential.
            port.probeDevice(next)
        }
        return port.apply(state, Change.Rotated(next))
    }

    /** A ready result is permission to attempt subscription sync, not proof of push delivery. */
    fun sync(): Ready? {
        var state = cleanup(port.state()) ?: return null
        if (state.pendingAction != "delete" && state.nextToken != null) {
            if (!recoverRotation(state.epoch)) return null
            state = port.state()
        }
        if (state.pendingAction == "delete") {
            state.token?.let {
                if (!current(state)) return null
                port.deleteDevice(it)
            }
            state.nextToken?.let {
                if (it != state.token) {
                    if (!current(state)) return null
                    port.deleteDevice(it)
                }
            }
            port.apply(state, Change.Deleted)
            return null
        }
        if (state.pendingAction == "stop") {
            state.token?.let {
                if (!current(state)) return null
                port.stopSubscription(it)
            }
            if (!port.apply(state, Change.StopAccepted)) return null
            state = port.state()
        }
        if (!state.enabled) {
            if (state.stopAwaiting && state.token != null) {
                if (!current(state)) return null
                val registration = port.getRegistration(state.token!!)
                port.apply(state, Change.StopObserved(registration))
            }
            return null
        }
        val token = state.token ?: return null
        val topic = state.topic ?: return null
        if (!current(state)) return null
        val mustPut = state.registrationEpoch != state.epoch || state.registration?.topic != topic || state.registration?.state == "stopped"
        val registration = (if (mustPut) port.putRegistration(token, topic) else port.getRegistration(token))
            ?: error("ntfyの登録結果を取得できません。")
        check(registration.topic == topic) { "ntfyの登録トピックが一致しません。" }
        if (!port.apply(state, Change.Registration(registration))) return null
        return if (registration.state == "ready" && current(state)) Ready(state.epoch, token) else null
    }

    companion object {
        fun sameOperation(expected: State, current: State) = expected.epoch == current.epoch &&
            expected.enabled == current.enabled && expected.pendingAction == current.pendingAction &&
            expected.stopAwaiting == current.stopAwaiting && expected.token == current.token &&
            expected.nextToken == current.nextToken && expected.cleanupToken == current.cleanupToken && expected.topic == current.topic

        fun pollDue(now: Long, previous: Long, interval: Long) = previous == 0L || now < previous || now - previous >= interval

        fun transition(state: State, change: Change): State = when (change) {
            is Change.Registration -> state.copy(registration = change.value,
                registrationEpoch = state.epoch,
                status = if (change.value.state == "ready") "通知先確認中" else "ntfyアカウント準備中")
            Change.StopAccepted -> state.copy(pendingAction = null, stopAwaiting = state.token != null,
                registration = state.registration?.copy(state = "pending", error = null),
                status = if (state.token == null) "停止中" else "停止受付済み：ntfy権限撤去待ち")
            is Change.StopObserved -> state.copy(registration = change.value,
                stopAwaiting = change.value != null && change.value.state != "stopped",
                status = when (change.value?.state) {
                    "stopped" -> "停止完了：ntfy権限撤去済み"
                    null -> "停止受付済み（自動登録なし）"
                    else -> "停止受付済み：ntfy権限撤去待ち"
                })
            Change.Deleted -> state.copy(enabled = false, pendingAction = null, stopAwaiting = false,
                token = null, nextToken = null, cleanupToken = null, topic = null, registration = null,
                registrationEpoch = -1, status = "端末削除受付済み（ntfy権限撤去は非同期）")
            Change.CleanupComplete -> state.copy(cleanupToken = null)
            is Change.TokenIssued -> state.copy(token = change.token)
            is Change.RotationStarted -> state.copy(nextToken = change.token)
            is Change.Rotated -> state.copy(token = change.token, nextToken = null)
        }
    }
}
