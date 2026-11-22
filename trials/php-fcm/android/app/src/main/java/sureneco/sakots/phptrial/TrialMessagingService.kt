package sureneco.sakots.phptrial

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class TrialMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val app = application as TrialApplication
        if (!app.firebaseReady) return
        val registration = app.publicRegistration
        if (registration != null) registration.onNewToken(token)
        else if (TrialNotifications.allowed(this)) app.state.saveToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val app = application as TrialApplication
        val registration = app.publicRegistration
        if (registration != null && message.data["type"] == "registration_challenge") {
            registration.onChallenge(message.data)
            return
        }
        synchronized(app.state) {
            app.state.receive(message.data, System.currentTimeMillis() / 1000, TrialNotifications.allowed(this),
                registration?.canNotify) {
                TrialNotifications.show(this, it)
            }
        }
    }
}
