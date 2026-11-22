package sureneco.sakots.phptrial

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

class TrialApplication : Application() {
    lateinit var state: TrialState
        private set
    internal var publicRegistration: PublicRegistration? = null
        private set
    var firebaseReady = false
        private set

    override fun onCreate() {
        super.onCreate()
        // Upgrades must discard the old on-disk selection bearer before any requests.
        if (!BuildConfig.PUBLIC_SERVICE) deleteSharedPreferences("thread_selection")
        state = TrialState(this)
        if (BuildConfig.PUBLIC_SERVICE) publicRegistration = PublicRegistration(this)
        TrialNotifications.createChannel(this)
        if (state.snapshot().enabled && !TrialNotifications.allowed(this)) state.stop()
        try {
            FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APP_ID)
                .setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                .build())
            FirebaseMessaging.getInstance().isAutoInitEnabled = publicRegistration?.started ?: state.snapshot().enabled
            firebaseReady = true
        } catch (_: RuntimeException) {
            // Never surface raw SDK exceptions: they can contain configuration values.
            if (!BuildConfig.PUBLIC_SERVICE) state.stop()
        }
    }
}
