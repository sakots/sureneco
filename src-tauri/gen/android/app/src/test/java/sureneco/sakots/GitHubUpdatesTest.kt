package sureneco.sakots

import android.app.Activity
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.security.Principal
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection
import java.net.URL

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class GitHubUpdatesTest {
    private fun apk(version: String) = "https://github.com/sakots/sureneco/releases/download/v$version/sureneco_v${version}_android.apk"
    private fun asset(version: String) = JSONObject().put("name", "sureneco_v${version}_android.apk").put("browser_download_url", apk(version))
    private fun release(version: String = "0.14.0") = JSONObject()
        .put("draft", false).put("prerelease", false).put("tag_name", "v$version")
        .put("assets", JSONArray().put(asset(version)))
    private class Fixture(version: String = "0.13.2", debug: Boolean = false, installer: () -> String? = { null }) {
        var body = ""
        var failure = false
        var calls = 0
        var duringFetch: (() -> Unit)? = null
        val updates = GitHubUpdates(version, debug, installer) {
            calls++
            duringFetch?.invoke()
            if (failure) error("untrusted remote detail https://attacker.invalid")
            body.toByteArray(Charsets.UTF_8)
        }
    }
    private fun rejectsOpen(updates: GitHubUpdates, activity: Activity) {
        try { updates.open(activity); fail("APK must not open") } catch (_: IllegalStateException) { }
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test fun checksOnlyOnRequestAndOpensOnlyVerifiedApkWithActionView() {
        val f = Fixture()
        f.body = release().toString()
        val idle = f.updates.state()
        assertEquals("0.13.2", idle.getString("version"))
        assertEquals("manual", idle.getString("mode"))
        assertEquals("idle", idle.getString("status"))
        assertTrue(idle.isNull("latestVersion"))
        assertTrue(idle.isNull("error"))
        assertEquals(0, idle.getInt("progress"))
        assertEquals(0, f.calls)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        rejectsOpen(f.updates, activity)
        f.duringFetch = {
            assertEquals("checking", f.updates.state().getString("status"))
            rejectsOpen(f.updates, activity)
        }
        val available = f.updates.check()
        assertEquals("available", available.getString("status"))
        assertEquals("0.14.0", available.getString("latestVersion"))
        assertEquals(1, f.calls)
        f.updates.open(activity)
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE))
        assertEquals(apk("0.14.0"), intent.dataString)
        assertNull(intent.type)
        assertEquals(1, f.calls)
    }

    @Test fun comparesIntegerTripletsRatherThanStrings() {
        for ((installed, latest, expected) in listOf(
            Triple("0.9.9", "0.10.0", "available"),
            Triple("0.13.2", "0.13.2", "current"),
            Triple("0.13.10", "0.13.9", "current"),
            Triple("1.0.0", "0.99.99", "current")
        )) {
            val f = Fixture(installed)
            f.body = release(latest).toString()
            val state = f.updates.check()
            assertEquals(expected, state.getString("status"))
            assertEquals(latest, state.getString("latestVersion"))
            if (expected == "current") rejectsOpen(f.updates, Robolectric.buildActivity(Activity::class.java).setup().get())
        }
    }

    @Test fun rejectsDraftPrereleaseInvalidTagsAndMissingOrDuplicateApks() {
        val malformed = listOf(
            release().put("draft", true), release().put("prerelease", true),
            release().put("draft", "false"), release().put("prerelease", JSONObject.NULL),
            release().put("tag_name", "0.14.0"), release().put("tag_name", "v0.14.0-beta.1"),
            release().put("tag_name", "v0.14.0+build"), release().put("tag_name", "v00.14.0"),
            release().put("tag_name", "v0.14.0\n"), release().put("tag_name", "v0.14.2147483648"),
            release().put("assets", JSONArray()), release().put("assets", JSONArray().put(asset("0.14.0")).put(asset("0.14.0"))),
            release("0.13.2").put("assets", JSONArray()), release("0.13.1").put("assets", JSONArray()),
            release().put("assets", JSONArray().put(asset("0.14.0").put("name", "renamed.apk")))
        )
        for (body in malformed) {
            val f = Fixture()
            f.body = body.toString()
            assertEquals(body.toString(), "error", f.updates.check().getString("status"))
            assertTrue(f.updates.state().isNull("latestVersion"))
        }
    }

    @Test fun rejectsEveryNonCanonicalDownloadUrl() {
        val canonical = apk("0.14.0")
        for (url in listOf(
            canonical.replace("https:", "http:"), canonical.replace("github.com", "attacker.invalid"),
            canonical.replace("github.com", "github.com.attacker.invalid"), canonical + "?download=1", canonical + "#apk",
            canonical.replace("download/v0.14.0/", "download/v0.13.2/"), canonical.replace("_android.apk", "_other.apk"),
            canonical.replace("github.com", "user@github.com"), canonical.replace("github.com", "github.com:443"),
            canonical.replace("/sakots/", "/other/")
        )) {
            val f = Fixture()
            f.body = release().put("assets", JSONArray().put(asset("0.14.0").put("browser_download_url", url))).toString()
            assertEquals(url, "error", f.updates.check().getString("status"))
        }
    }

    @Test fun failureClearsOldApkAndCanRecoverWithoutLeakingRemoteDetails() {
        val f = Fixture()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        f.body = release().toString()
        assertEquals("available", f.updates.check().getString("status"))
        f.failure = true
        val failed = f.updates.check()
        assertEquals("error", failed.getString("status"))
        assertTrue(failed.isNull("latestVersion"))
        assertEquals("更新を確認できませんでした。通信環境を確認して再試行してください。", failed.getString("error"))
        rejectsOpen(f.updates, activity)
        f.failure = false
        f.body = "not JSON https://attacker.invalid"
        assertEquals("error", f.updates.check().getString("status"))
        rejectsOpen(f.updates, activity)
        f.body = release("0.15.0").toString()
        assertEquals("available", f.updates.check().getString("status"))
        f.updates.open(activity)
        assertEquals(apk("0.15.0"), shadowOf(activity).nextStartedActivity.dataString)
    }

    @Test fun networkWaitDoesNotHoldTheUiStateMonitor() {
        val started = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val updates = GitHubUpdates("0.13.2", false, { null }) {
            started.countDown()
            check(finish.await(5, TimeUnit.SECONDS))
            release().toString().toByteArray()
        }
        val worker = Thread { updates.check() }
        worker.start()
        try {
            assertTrue(started.await(2, TimeUnit.SECONDS))
            val observed = CountDownLatch(1)
            val reader = Thread {
                assertEquals("checking", updates.state().getString("status"))
                observed.countDown()
            }
            reader.start()
            assertTrue("state() must not wait for HTTP", observed.await(1, TimeUnit.SECONDS))
            reader.join()
        } finally {
            finish.countDown()
            worker.join(2000)
        }
        assertEquals("available", updates.state().getString("status"))
    }

    @Test fun playDebugAndUnknownInstallerFailureNeverConnectOrOpen() {
        for (f in listOf(
            Fixture(debug = true, installer = { error("must not inspect debug installer") }),
            Fixture(installer = { "com.android.vending" }),
            Fixture(installer = { throw SecurityException("unavailable") })
        )) {
            assertEquals("disabled", f.updates.state().getString("mode"))
            assertEquals("disabled", f.updates.check().getString("status"))
            assertEquals(0, f.calls)
            rejectsOpen(f.updates, Robolectric.buildActivity(Activity::class.java).setup().get())
        }
    }

    private class Connection(var code: Int = 200, var bytes: ByteArray = ByteArray(0), var length: Long = -1) :
        HttpsURLConnection(URL("https://api.github.com/repos/sakots/sureneco/releases/latest")) {
        var disconnected = false
        override fun connect() = Unit
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getResponseCode() = code
        override fun getContentLengthLong() = length
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getCipherSuite() = "test"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getPeerPrincipal(): Principal? = null
        override fun getLocalPrincipal(): Principal? = null
    }

    @Test fun boundsHttpResponsesRejectsRedirectsAndUsesTimeouts() {
        val good = Connection(bytes = release().toString().toByteArray())
        assertArrayEquals(good.bytes, GitHubUpdates.fetchRelease { good })
        assertFalse(good.instanceFollowRedirects)
        assertTrue(good.connectTimeout in 1..15000)
        assertTrue(good.readTimeout in 1..15000)
        assertTrue(good.disconnected)
        for (connection in listOf(
            Connection(code = 302), Connection(code = 404), Connection(code = 429),
            Connection(length = 262145), Connection(bytes = ByteArray(262145))
        )) {
            try { GitHubUpdates.fetchRelease { connection }; fail("must reject HTTP response") } catch (_: IllegalStateException) { }
            assertTrue(connection.disconnected)
        }
    }

    @Test fun rejectsOversizedInvalidUtf8AndTrailingJson() {
        for (bytes in listOf(ByteArray(262145), byteArrayOf(0xc3.toByte(), 0x28), (release().toString() + " {}").toByteArray())) {
            val updates = GitHubUpdates("0.13.2", false, { null }) { bytes }
            assertEquals("error", updates.check().getString("status"))
            assertTrue(updates.state().isNull("latestVersion"))
        }
    }
}
