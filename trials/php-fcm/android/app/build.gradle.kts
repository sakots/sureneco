import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val trialPackage = "sureneco.sakots.phptrial"
val configFile = providers.environmentVariable("SURENECO_FCM_TRIAL_CONFIG").orNull
    ?.let { rootProject.file(it) }
    ?: rootProject.file("../../../.secrets/php-fcm/google-services.json")
fun configFailure(): Nothing = throw GradleException(
    "FCM trial client configuration is missing or invalid. Set SURENECO_FCM_TRIAL_CONFIG to the private google-services.json for sureneco.sakots.phptrial."
)
val config = try {
    if (!configFile.isFile || configFile.length() !in 1..262144) configFailure()
    JsonSlurper().parse(configFile, "UTF-8") as? Map<*, *> ?: configFailure()
} catch (_: Exception) { configFailure() }
val projectInfo = config["project_info"] as? Map<*, *> ?: configFailure()
val projectId = projectInfo["project_id"] as? String ?: configFailure()
val senderId = projectInfo["project_number"] as? String ?: configFailure()
if (!projectId.matches(Regex("[a-z][a-z0-9-]{4,28}[a-z0-9]")) || !senderId.matches(Regex("[0-9]{1,30}"))) configFailure()
val clients = (config["client"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.filter {
    val info = it["client_info"] as? Map<*, *>
    val android = info?.get("android_client_info") as? Map<*, *>
    android?.get("package_name") == trialPackage
} ?: configFailure()
if (clients.size != 1) configFailure()
val clientInfo = clients.single()["client_info"] as? Map<*, *> ?: configFailure()
val firebaseAppId = clientInfo["mobilesdk_app_id"] as? String ?: configFailure()
if (!firebaseAppId.matches(Regex("1:${senderId}:android:[a-f0-9]+"))) configFailure()
val apiKeys = (clients.single()["api_key"] as? List<*>)?.filterIsInstance<Map<*, *>>()
    ?.mapNotNull { it["current_key"] as? String } ?: configFailure()
if (apiKeys.size != 1 || !apiKeys.single().matches(Regex("AIza[A-Za-z0-9_-]{20,80}"))) configFailure()

android {
    namespace = trialPackage
    compileSdk = 36
    defaultConfig {
        applicationId = trialPackage
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0-trial"
        // Only these public client values are generated. Never package the source JSON.
        buildConfigField("String", "FCM_PROJECT_ID", "\"$projectId\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"$senderId\"")
        buildConfigField("String", "FCM_APP_ID", "\"$firebaseAppId\"")
        buildConfigField("String", "FCM_API_KEY", "\"${apiKeys.single()}\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
androidComponents {
    beforeVariants(selector().withBuildType("release")) { it.enable = false }
}
kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }
dependencies {
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    testImplementation("junit:junit:4.13.2")
}
