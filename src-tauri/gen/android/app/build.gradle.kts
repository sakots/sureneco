import java.util.Properties
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

val releaseBuild = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}
fun mobileProperty(name: String): String =
    mobileProperties.getProperty(name)?.trim().orEmpty()
fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val apiBaseUrl = mobileProperty("sureneco.apiBaseUrl")
val firebaseProjectId = mobileProperty("sureneco.firebaseProjectId")
val firebaseProjectNumber = mobileProperty("sureneco.firebaseProjectNumber")
val firebaseAppId = mobileProperty("sureneco.firebaseAppId")
if (apiBaseUrl.isNotEmpty() && !apiBaseUrl.startsWith("https://")) {
    throw GradleException("sureneco.apiBaseUrl must use https://")
}
if (releaseBuild && listOf(
        apiBaseUrl,
        firebaseProjectId,
        firebaseProjectNumber,
        firebaseAppId,
    ).any(String::isEmpty)
) {
    throw GradleException(
        "mobile.properties must define the public Firebase settings and HTTPS API URL for release builds",
    )
}

android {
    compileSdk = 36
    namespace = "io.github.sakots.sureneco"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "io.github.sakots.sureneco"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "SURENECO_API_BASE_URL", buildConfigString(apiBaseUrl))
        buildConfigField("String", "SURENECO_FIREBASE_PROJECT_ID", buildConfigString(firebaseProjectId))
        buildConfigField("String", "SURENECO_FIREBASE_PROJECT_NUMBER", buildConfigString(firebaseProjectNumber))
        buildConfigField("String", "SURENECO_FIREBASE_APP_ID", buildConfigString(firebaseAppId))
        ndk {
            abiFilters.add("arm64-v8a")
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
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
