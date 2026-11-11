package sureneco.sakots.phptrial

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

object TrialNotifications {
    private const val CHANNEL_ID = "php_fcm_connectivity_trial"
    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) manager(context).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "PHP・FCM 接続試験", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "明示的に送信した接続試験だけを表示します"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )
    }

    fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!manager(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 26 || manager(context).getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun show(context: Context, payload: ReceiptPolicy.Payload): TrialState.Delivery {
        if (!allowed(context)) return TrialState.Delivery.BLOCKED
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val click = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL_ID) else Notification.Builder(context)
        val notification = builder.setSmallIcon(R.drawable.ic_trial_notification)
            .setContentTitle(payload.title).setContentText(payload.body)
            .setStyle(Notification.BigTextStyle().bigText(payload.body))
            .setContentIntent(click).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(Notification.CATEGORY_STATUS).build()
        return try {
            manager(context).notify(payload.eventId, 1, notification)
            TrialState.Delivery.SHOWN
        } catch (_: SecurityException) { TrialState.Delivery.BLOCKED }
          catch (_: RuntimeException) { TrialState.Delivery.FAILED }
    }

    fun clear(context: Context) = manager(context).cancelAll()
}
