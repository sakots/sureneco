package sureneco.sakots.phptrial

import android.app.Activity
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

internal class TrialWidgets(private val activity: Activity) {
    val bg = activity.getColor(R.color.trial_background)
    val panel = activity.getColor(R.color.trial_panel)
    val text = activity.getColor(R.color.trial_text)
    val muted = activity.getColor(R.color.trial_muted)
    val border = activity.getColor(R.color.trial_border)
    val accent = activity.getColor(R.color.trial_accent)
    val onAccent = activity.getColor(R.color.trial_on_accent)
    val soft = activity.getColor(R.color.trial_soft)
    val errorBg = activity.getColor(R.color.trial_error_bg)
    val errorText = activity.getColor(R.color.trial_error_text)
    val focus = activity.getColor(R.color.trial_focus)
    private val config = activity.resources.configuration
    val wide = config.screenWidthDp >= 560 && config.fontScale <= 1.25f
    private val density = activity.resources.displayMetrics.density

    fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    fun row() = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }

    fun add(parent: LinearLayout, view: View, top: Int = 0) {
        parent.addView(view, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) })
    }

    fun label(value: CharSequence = "", size: Float = 14f, color: Int = text, bold: Boolean = false) =
        TextView(activity).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    fun heading(value: String, size: Float = 18f) = label(value, size, bold = true).apply {
        if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }

    fun badge(value: String, emphasized: Boolean = false) = label(value, 12f).apply {
        setPadding(dp(7), dp(2), dp(7), dp(2))
        styleBadge(this, emphasized)
    }

    fun styleBadge(view: TextView, emphasized: Boolean) {
        view.setTextColor(if (emphasized) accent else muted)
        view.background = shape(if (emphasized) soft else bg, 5)
    }

    fun shape(fill: Int, radius: Int, stroke: Int? = null, dashed: Boolean = false) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        if (stroke != null) {
            if (dashed) setStroke(dp(1), stroke, dp(5).toFloat(), dp(3).toFloat())
            else setStroke(dp(1), stroke)
        }
    }

    fun cardBackground(active: Boolean = false) = if (active) {
        LayerDrawable(arrayOf(shape(accent, 10), shape(panel, 10, border))).apply {
            setLayerInset(1, dp(3), 0, 0, 0)
        }
    } else shape(panel, 10, border)

    fun card(title: String): LinearLayout = column().apply {
        background = shape(panel, 12, border)
        setPadding(dp(14), dp(12), dp(14), dp(14))
        add(this, heading(title, 15f))
    }

    fun button(value: String, primary: Boolean = false, link: Boolean = false, action: () -> Unit) = Button(activity).apply {
        text = value
        textSize = 14f
        isAllCaps = false
        val disabled = intArrayOf(-android.R.attr.state_enabled)
        val color = if (primary) onAccent else if (link) accent else this@TrialWidgets.text
        setTextColor(ColorStateList(arrayOf(disabled, intArrayOf()), intArrayOf(muted, color)))
        stateListAnimator = null
        minimumHeight = dp(48)
        minHeight = dp(48)
        minimumWidth = 0
        minWidth = 0
        val fill = if (primary) accent else if (link) Color.TRANSPARENT else panel
        val edge = if (primary) accent else if (link) null else border
        val buttonShape = StateListDrawable().apply {
            addState(disabled, shape(if (link) Color.TRANSPARENT else bg, 8, if (link) null else border))
            addState(intArrayOf(android.R.attr.state_focused), shape(fill, 8, focus))
            addState(intArrayOf(), shape(fill, 8, edge))
        }
        background = RippleDrawable(
            ColorStateList.valueOf((this@TrialWidgets.accent and 0x00ff_ffff) or 0x2400_0000),
            buttonShape, shape(Color.WHITE, 8),
        )
        setPadding(dp(if (link) 0 else 12), dp(6), dp(if (link) 0 else 12), dp(6))
        if (link) {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setTypeface(typeface, Typeface.BOLD)
        }
        setOnClickListener { action() }
    }

    fun divider() = View(activity).apply {
        setBackgroundColor(border)
        layoutParams = LinearLayout.LayoutParams(-1, dp(1))
    }

    fun message(view: TextView, error: Boolean = false) {
        view.setTextColor(if (error) errorText else accent)
        view.background = shape(if (error) errorBg else soft, 8)
        view.setPadding(dp(12), dp(8), dp(12), dp(8))
    }

    @Suppress("DEPRECATION")
    fun install(content: View) {
        val window = activity.window
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val light = config.uiMode and Configuration.UI_MODE_NIGHT_MASK != Configuration.UI_MODE_NIGHT_YES
        if (Build.VERSION.SDK_INT < 30) {
            var flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            if (light) {
                flags = flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                if (Build.VERSION.SDK_INT >= 26) flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
            window.decorView.systemUiVisibility = flags
        }
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = if (light && Build.VERSION.SDK_INT < 26) muted else Color.TRANSPARENT
        val root = FrameLayout(activity).apply {
            setBackgroundColor(bg)
            if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            if (Build.VERSION.SDK_INT >= 29) importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
            val width = if (config.screenWidthDp > 1100) dp(1100) else -1
            addView(content, FrameLayout.LayoutParams(width, -1, Gravity.CENTER_HORIZONTAL))
            setOnApplyWindowInsetsListener { view, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val space = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                    view.setPadding(space.left, space.top, space.right, space.bottom)
                } else {
                    view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        }
        activity.setContentView(root)
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) lightBars else 0, lightBars)
        }
        root.requestApplyInsets()
    }
}
