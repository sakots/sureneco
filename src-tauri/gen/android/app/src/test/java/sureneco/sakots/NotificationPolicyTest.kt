package sureneco.sakots
import org.junit.Assert.*
import org.junit.Test
class NotificationPolicyTest {
 @Test fun rejectsStoppedExpiredOldSettingsOldChannelAndDuplicates() {
  fun accept(enabled:Boolean=true,permission:Boolean=true,decrypted:Boolean=true,revision:Long=5,generation:String="new",expires:Long=101,seen:Boolean=false)=NotificationPolicy.accepts(enabled,permission,decrypted,revision,5,generation,"new",expires,100,seen)
  assertTrue(accept());assertFalse(accept(enabled=false));assertFalse(accept(permission=false));assertFalse(accept(decrypted=false));assertFalse(accept(revision=4));assertFalse(accept(generation="old"));assertFalse(accept(expires=100));assertFalse(accept(seen=true))
 }
}
