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
    private fun page(vararg releases: JSONObject) = JSONArray(releases.toList()).toString()
    private fun pcRelease(version: String) = release(version).put("assets", JSONArray()
        .put(JSONObject().put("name", "sureneco_${version}_x64.exe")))
    private fun fullPcPage(version: String = "1.0.0") =
        JSONArray(List(10) { pcRelease(version) }).toString()
    private class Fixture(version: String = "0.13.2", debug: Boolean = false, installer: () -> String? = { null }) {
        var body = "[]"
        var pages: List<String>? = null
        val requestedPages = mutableListOf<Int>()
        var failPage: Int? = null
        var failure = false
        var calls = 0
        var duringFetch: (() -> Unit)? = null
        val updates = GitHubUpdates(version, debug, installer) { page ->
            calls++
            requestedPages.add(page)
            duringFetch?.invoke()
            if (failure || page == failPage) error("untrusted remote detail https://attacker.invalid")
            (pages?.get(page - 1) ?: body).toByteArray(Charsets.UTF_8)
        }
    }
    private fun rejectsOpen(updates: GitHubUpdates, activity: Activity) {
        try { updates.open(activity); fail("APK must not open") } catch (_: IllegalStateException) { }
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test fun checksOnlyOnRequestAndOpensOnlyVerifiedApkWithActionView() {
        val f = Fixture()
        f.body = page(release())
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
            f.body = page(release(latest))
            val state = f.updates.check()
            assertEquals(expected, state.getString("status"))
            assertEquals(latest, state.getString("latestVersion"))
            if (expected == "current") rejectsOpen(f.updates, Robolectric.buildActivity(Activity::class.java).setup().get())
        }
    }

    @Test fun skipsPcDraftPrereleaseAndInvalidTagsWhileSelectingLargestAndroidVersion() {
        val ignored = listOf(
            pcRelease("9.0.0"),
            release("8.0.0").put("draft", true), release("7.0.0").put("prerelease", true),
            release().put("draft", "false"), release().put("prerelease", JSONObject.NULL),
            release().put("tag_name", "0.14.0"), release().put("tag_name", "v0.14.0-beta.1"),
            release().put("tag_name", "v0.14.0+build"), release().put("tag_name", "v00.14.0"),
            release().put("tag_name", "v0.14.0\n"), release().put("tag_name", "v0.14.2147483648")
        )
        val f = Fixture()
        f.pages = (ignored + listOf(release("0.9.0"), release("0.14.0"), release("0.13.9")))
            .chunked(10).map { page(*it.toTypedArray()) }
        assertEquals("available", f.updates.check().getString("status"))
        assertEquals("0.14.0", f.updates.state().getString("latestVersion"))
        f.pages = ignored.chunked(10).map { page(*it.toTypedArray()) }
        assertEquals("current", f.updates.check().getString("status"))
        assertTrue(f.updates.state().isNull("latestVersion"))
        rejectsOpen(f.updates, Robolectric.buildActivity(Activity::class.java).setup().get())
    }

    @Test fun findsAndroidBehindMultipleFullPcPagesAndIgnoresListOrder() {
        val f = Fixture()
        f.pages = listOf(fullPcPage("9.0.0"), fullPcPage("8.0.0"),
            page(release("0.13.9"), release("0.14.0"), release("0.10.0")))
        assertEquals("available", f.updates.check().getString("status"))
        assertEquals("0.14.0", f.updates.state().getString("latestVersion"))
        assertEquals(listOf(1, 2, 3), f.requestedPages)
    }

    @Test fun newerMalformedAndroidCannotBeHiddenByOlderValidRelease() {
        val malformed = listOf(
            release().put("assets", JSONArray().put(asset("0.14.0")).put(asset("0.14.0"))),
            release().put("assets", JSONArray().put(asset("0.14.0").put("name", "renamed.apk"))),
            release().put("assets", JSONArray().put(asset("0.14.0").put("browser_download_url", "https://attacker.invalid/app.apk"))),
            release().put("assets", JSONArray().put(asset("0.14.0").put("name", "sureneco_v0.13.2_android.apk")))
        )
        for (bad in malformed) {
            val f = Fixture()
            f.body = page(release("0.13.3"), bad)
            assertEquals(bad.toString(), "error", f.updates.check().getString("status"))
            assertTrue(f.updates.state().isNull("latestVersion"))
        }
        val f = Fixture()
        f.body = page(malformed.first(), release("0.15.0"))
        assertEquals("available", f.updates.check().getString("status"))
        assertEquals("0.15.0", f.updates.state().getString("latestVersion"))
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
            f.body = page(release().put("assets", JSONArray().put(asset("0.14.0").put("browser_download_url", url))))
            assertEquals(url, "error", f.updates.check().getString("status"))
        }
    }

    @Test fun failureClearsOldApkAndCanRecoverWithoutLeakingRemoteDetails() {
        val f = Fixture()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        f.body = page(release())
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
        f.body = page(release("0.15.0"))
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
            page(release()).toByteArray()
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

    private class Connection(var code: Int = 200, var bytes: ByteArray = ByteArray(0), var length: Long = -1,
        private val link: String? = null) :
        HttpsURLConnection(URL("https://api.github.com/repos/sakots/sureneco/releases?per_page=10&page=1")) {
        var disconnected = false
        override fun connect() = Unit
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getResponseCode() = code
        override fun getContentLengthLong() = length
        override fun getHeaderField(name: String?): String? = if (name.equals("Link", true)) link else null
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getCipherSuite() = "test"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getPeerPrincipal(): Principal? = null
        override fun getLocalPrincipal(): Principal? = null
    }

    @Test fun boundsHttpResponsesRejectsRedirectsAndUsesTimeouts() {
        val good = Connection(bytes = page(release()).toByteArray(),
            link = "<https://attacker.invalid/releases?page=999>; rel=\"next\"")
        var requested: URL? = null
        assertArrayEquals(good.bytes, GitHubUpdates.fetchRelease(2) { url -> requested = url; good })
        assertEquals("https://api.github.com/repos/sakots/sureneco/releases?per_page=10&page=2", requested.toString())
        assertFalse(good.instanceFollowRedirects)
        assertTrue(good.connectTimeout in 1..15000)
        assertTrue(good.readTimeout in 1..15000)
        assertTrue(good.disconnected)
        for (connection in listOf(
            Connection(code = 302), Connection(code = 404), Connection(code = 429),
            Connection(length = 262145), Connection(bytes = ByteArray(262145))
        )) {
            try { GitHubUpdates.fetchRelease(1) { connection }; fail("must reject HTTP response") } catch (_: IllegalStateException) { }
            assertTrue(connection.disconnected)
        }
    }

    @Test fun rejectsOversizedInvalidUtf8AndTrailingJson() {
        for (bytes in listOf(ByteArray(262145), byteArrayOf(0xc3.toByte(), 0x28),
            (page(release()) + " {}").toByteArray(), release().toString().toByteArray())) {
            val updates = GitHubUpdates("0.13.2", false, { null }) { bytes }
            assertEquals("error", updates.check().getString("status"))
            assertTrue(updates.state().isNull("latestVersion"))
        }
    }

    @Test fun pageFailureAndSafetyLimitsClearPreviouslyVerifiedUrl() {
        val oversizedPage = JSONArray(List(10) { pcRelease("9.0.0") })
            .put(0, release().put("padding", "x".repeat(220000))).toString()
        assertTrue(oversizedPage.toByteArray().size < 262144)
        val cases = listOf(
            Pair(listOf(fullPcPage(), page(release())), 2),
            Pair(List(10) { fullPcPage() }, null),
            Pair(List(5) { oversizedPage }, null)
        )
        for ((pages, failPage) in cases) {
            val f = Fixture()
            f.body = page(release())
            assertEquals("available", f.updates.check().getString("status"))
            f.pages = pages
            f.failPage = failPage
            val failed = f.updates.check()
            assertEquals("error", failed.getString("status"))
            assertTrue(failed.isNull("latestVersion"))
            rejectsOpen(f.updates, Robolectric.buildActivity(Activity::class.java).setup().get())
            assertTrue(f.requestedPages.maxOrNull()!! <= 10)
        }
    }
}
