package sureneco.sakots

import android.content.Intent
import android.os.Bundle
import org.unifiedpush.android.connector.UnifiedPush
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
    PushState.executor.execute {
      try {
        if (PushState.desired(this)) {
          val vapid = PushState.prepare(this)
          runOnUiThread { UnifiedPush.tryUseCurrentOrDefaultDistributor(this) { success ->
            if (success) UnifiedPush.register(this, messageForDistributor = "スレネコアラートの友人戦募集通知", vapid = vapid)
            else PushState.mark(this, "中継アプリ未導入：ntfyの設定を確認してください")
          } }
        }
        PushState.sync(this)
      } catch (_: Exception) { PushState.failed(this) }
    }
  }
  override fun onResume() {
    super.onResume()
    if (PushState.desired(this) && !androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) PushState.suppress(this, "stop")
    if (PushState.prefs(this).getString("pending", null) != null) PushState.executor.execute { try { PushState.sync(this) } catch (_: Exception) { PushState.failed(this) } }
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
