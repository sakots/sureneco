package sureneco.sakots.phptrial

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

class TrialApplication : Application() {
    lateinit var state: TrialState
        private set
    var firebaseReady = false
        private set

    override fun onCreate() {
        super.onCreate()
        state = TrialState(this)
        TrialNotifications.createChannel(this)
        if (state.snapshot().enabled && !TrialNotifications.allowed(this)) state.stop()
        try {
            FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APP_ID)
                .setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                .build())
            FirebaseMessaging.getInstance().isAutoInitEnabled = state.snapshot().enabled
            firebaseReady = true
        } catch (_: RuntimeException) {
            // Never surface raw SDK exceptions: they can contain configuration values.
            state.stop()
        }
    }
}
