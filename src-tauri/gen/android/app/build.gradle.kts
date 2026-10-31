import java.util.Properties
import java.net.URI
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val mobileProperties = Properties().apply {
    val propFile = file("mobile.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Keep the JNI implementation paired with the version selected by Cargo.
val rustlsVerifierVersion = providers.fileContents(
    rootProject.layout.projectDirectory.file("../../Cargo.lock")
).asText.map { lock ->
    Regex("""name = "rustls-platform-verifier-android"\r?\nversion = "([^"]+)"""")
        .find(lock)?.groupValues?.get(1)
        ?: error("rustls-platform-verifier-android not found in Cargo.lock")
}

val releaseBuild = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}
fun mobileProperty(name: String): String =
    mobileProperties.getProperty(name)?.trim().orEmpty()
fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val apiBaseUrl = (System.getenv("SURENECO_API_BASE_URL") ?: mobileProperty("sureneco.apiBaseUrl")).trim().removeSuffix("/")
val ntfyOrigin = (System.getenv("SURENECO_NTFY_ORIGIN") ?: mobileProperty("sureneco.ntfyOrigin")).trim().removeSuffix("/")
for (value in listOf(apiBaseUrl, ntfyOrigin)) {
    if (value.isNotEmpty()) {
        val uri = URI(value)
        if (releaseBuild && uri.host?.endsWith(".invalid") == true) throw GradleException("Release endpoints must use the deployed hosts")
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.userInfo != null || uri.query != null || uri.fragment != null || !uri.path.isNullOrEmpty())
            throw GradleException("Mobile endpoints must be HTTPS origins without paths or credentials")
    }
}
if (releaseBuild && listOf(apiBaseUrl, ntfyOrigin).any(String::isEmpty))
    throw GradleException("mobile.properties must define HTTPS API and self-hosted ntfy origins")

android {
    compileSdk = 36
    namespace = "sureneco.sakots"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "sureneco.sakots"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "SURENECO_API_BASE_URL", buildConfigString(apiBaseUrl))
        buildConfigField("String", "SURENECO_NTFY_ORIGIN", buildConfigString(ntfyOrigin))
        ndk {
            abiFilters.add("arm64-v8a")
        }
    }
    val signingProperties = Properties().apply {
        val source = System.getenv("SURENECO_ANDROID_SIGNING_FILE")?.let { file(it) } ?: rootProject.file("keystore.properties")
        if (source.exists()) source.inputStream().use { load(it) }
    }
    if (releaseBuild) {
        if (listOf("storeFile", "storePassword", "keyAlias", "keyPassword").any { signingProperties.getProperty(it).isNullOrBlank() })
            throw GradleException("Release builds require separate Android upload signing settings")
        signingConfigs.create("upload") {
            storeFile = file(signingProperties.getProperty("storeFile"))
            storePassword = signingProperties.getProperty("storePassword")
            keyAlias = signingProperties.getProperty("keyAlias")
            keyPassword = signingProperties.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (releaseBuild) signingConfig = signingConfigs.getByName("upload")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("org.rustls:rustls-platform-verifier:${rustlsVerifierVersion.get()}")
    implementation("org.unifiedpush.android:connector:3.3.5")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
}

apply(from = file("tauri.build.gradle.kts"))

configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.google.crypto.tink:tink")).using(module("com.google.crypto.tink:tink-android:1.23.0"))
    }
}
