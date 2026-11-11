package sureneco.sakots.phptrial

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class TrialMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val app = application as TrialApplication
        if (app.firebaseReady && TrialNotifications.allowed(this)) app.state.saveToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val app = application as TrialApplication
        app.state.receive(message.data, System.currentTimeMillis() / 1000, TrialNotifications.allowed(this)) {
            TrialNotifications.show(this, it)
        }
    }
}
