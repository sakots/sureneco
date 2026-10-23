package sureneco.sakots

import org.junit.Assert.assertTrue
import org.junit.Test

class TlsVerifierTest {
    @Test
    fun includesTheCertificateVerifierCalledByRust() {
        val verifier = Class.forName(
            "org.rustls.platformverifier.CertificateVerifier",
            false,
            javaClass.classLoader,
        )
        assertTrue(verifier.declaredMethods.any { it.name == "verifyCertificateChain" })
    }
}
