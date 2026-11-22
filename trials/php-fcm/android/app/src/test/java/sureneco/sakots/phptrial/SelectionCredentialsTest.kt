package sureneco.sakots.phptrial

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SelectionCredentialsTest {
    private val token = "a0".repeat(32)

    @Test fun acceptsHttpsEndpointWithQuery() {
        assertNotNull(SelectionCredentials.parse("https://example.com/api/selection.php?mode=trial", token))
    }

    @Test fun rejectsAmbiguousOrInsecureEndpoints() {
        for (endpoint in listOf(
            "http://example.com/selection.php", "https:///selection.php", "https:selection.php",
            "https://example.com@another.example/selection.php", "https://example.com/selection.php#fragment",
            "https://example.com:65536/selection.php"
        )) {
            assertNull(endpoint, SelectionCredentials.parse(endpoint, token))
        }
    }

    @Test fun requiresExactly64LowercaseHexCharacters() {
        for (invalid in listOf(token.dropLast(1), token + "0", token.uppercase(), "g" + token.drop(1), "$token\n")) {
            assertNull(SelectionCredentials.parse("https://example.com/selection.php", invalid))
        }
    }
}
