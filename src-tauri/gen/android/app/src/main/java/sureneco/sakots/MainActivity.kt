package sureneco.sakots

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val edges = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout() or androidx.core.view.WindowInsetsCompat.Type.ime())
      view.setPadding(edges.left, edges.top, edges.right, edges.bottom)
      insets
    }
    rememberTarget(intent)
    val expected = PushState.epoch(this)
    PushState.executor.execute {
      try {
        if (PushState.active(this, expected)) PushState.register(this, expected, pick = false) { }
        else PushState.sync(this)
      } catch (_: Exception) { PushState.failed(this, expected) }
    }
  }
  override fun onResume() {
    super.onResume()
    if (PushState.desired(this) && !androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) PushState.suppress(this, "stop")
    val expected = PushState.epoch(this)
    PushState.executor.execute { try { PushState.refreshStatus(this) } catch (_: Exception) { PushState.failed(this, expected) } }
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    rememberTarget(intent)
  }
  private fun rememberTarget(intent: Intent?) {
    if (intent?.getBooleanExtra("showRecruitments", false) == true)
      PushState.prefs(this).edit().putBoolean("showRecruitments", true).commit()
  }
}
