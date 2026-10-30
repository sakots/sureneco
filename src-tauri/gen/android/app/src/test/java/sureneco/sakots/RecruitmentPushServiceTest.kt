package sureneco.sakots

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.data.PushMessage

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class RecruitmentPushServiceTest {
    private lateinit var service: RecruitmentPushService
    private lateinit var manager: NotificationManager
    private val expires get() = System.currentTimeMillis() / 1000 + 86400

    @Before fun setup() {
        service = Robolectric.buildService(RecruitmentPushService::class.java).create().get()
        manager = service.getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(true)
        PushState.prefs(service).edit().clear().putBoolean("enabled", true)
            .putLong("revision", 5).putString("generation", "current").commit()
    }

    private fun event(type: String = "new_thread", id: String = "a".repeat(64)) = JSONObject()
        .put("type", type).put("eventId", id).put("revision", 5).put("generation", "current")
        .put("boardUrl", "https://egg.5ch.net/mj/").put("threadId", "1791034502")
        .put("threadTitle", "新しい候補").put("expiresAt", expires)
        .apply { if (type == "recruitment") put("recruitment", JSONObject().put("number", 23).put("body", "友人戦 12345").put("closed", false)) }

    private fun receive(data: JSONObject, decrypted: Boolean = true, instance: String = INSTANCE_DEFAULT) =
        service.onMessage(PushMessage(data.toString().toByteArray(), decrypted), instance)

    private fun notification(id: String) = shadowOf(manager).getNotification(id.hashCode())

    @Test fun newThreadRendersWithoutRecruitmentAndKeepsItsTapTargetAfterRecruitmentArrives() {
        val threadId = "a".repeat(64)
        val recruitmentId = "b".repeat(64)
        receive(event(id = threadId))
        val thread = notification(threadId)
        assertNotNull(thread)
        assertEquals("threads", thread.channelId)
        assertEquals("新しいスレッド · 新しい候補", thread.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertTrue(thread.timeoutAfter > 0)
        receive(event("recruitment", recruitmentId))
        val recruitment = notification(recruitmentId)
        assertNotNull(recruitment)
        assertEquals("recruitments", recruitment.channelId)
        assertEquals("友人戦募集 · 新しい候補", recruitment.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("レス 23：友人戦 12345", recruitment.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertNotEquals(thread.contentIntent, recruitment.contentIntent)
        for ((item, target) in listOf(thread to "threads", recruitment to "recruitments", thread to "threads")) {
            val launch = Intent(shadowOf(item.contentIntent).savedIntent)
            assertEquals(MainActivity::class.java.name, launch.component?.className)
            PushState.rememberNotificationTarget(service, launch)
            assertEquals(target, PushState.consumeNotificationTarget(service))
            assertNull(PushState.consumeNotificationTarget(service))
            PushState.rememberNotificationTarget(service, launch)
            assertNull(PushState.consumeNotificationTarget(service))
        }
        PushState.rememberNotificationTarget(service, Intent().putExtra("notificationTarget", "settings"))
        assertNull(PushState.consumeNotificationTarget(service))
    }

    @Test fun rejectsUnknownExpiredStoppedUnpermittedUnauthenticatedStaleAndDuplicateMessages() {
        val id = "a".repeat(64)
        val p = PushState.prefs(service)
        receive(event("unknown")); assertNull(notification(id))
        receive(event().put("expiresAt", System.currentTimeMillis() / 1000)); assertNull(notification(id))
        receive(event().put("revision", 4)); assertNull(notification(id))
        receive(event().put("generation", "old")); assertNull(notification(id))
        receive(event().put("eventId", "bad")); assertNull(notification("bad"))
        receive(event(), decrypted = false); assertNull(notification(id))
        receive(event(), instance = "other"); assertNull(notification(id))
        p.edit().putBoolean("enabled", false).commit()
        receive(event()); assertNull(notification(id))
        p.edit().putBoolean("enabled", true).putString("pending", "stop").commit()
        receive(event()); assertNull(notification(id))
        p.edit().remove("pending").commit()
        shadowOf(manager).setNotificationsEnabled(false)
        receive(event()); assertNull(notification(id))
        shadowOf(manager).setNotificationsEnabled(true)
        receive(event())
        assertNotNull(notification(id))
        manager.cancel(id.hashCode())
        receive(event())
        assertNull(notification(id))
        assertTrue(JSONObject(p.getString("seen", "{}")!!).has(id))
    }

    @Test fun closedRecruitmentIsNotDisplayedOrRemembered() {
        val data = event("recruitment")
        data.getJSONObject("recruitment").put("closed", true)
        receive(data)
        assertNull(notification(data.getString("eventId")))
        assertFalse(JSONObject(PushState.prefs(service).getString("seen", "{}")!!).has(data.getString("eventId")))
    }
}
