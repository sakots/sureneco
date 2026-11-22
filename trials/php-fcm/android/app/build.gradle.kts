import com.android.build.api.variant.BuildConfigField
import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val trialPackage = "sureneco.sakots.phptrial"
val publicPackage = "sureneco.sakots.php"
val trialConfig = providers.environmentVariable("SURENECO_FCM_TRIAL_CONFIG")
    .map { rootProject.file(it) }
    .orElse(rootProject.file("../../../.secrets/php-fcm/google-services.json"))
val releaseConfig = rootProject.file("../../../.secrets/php-fcm/google-services-release.json")

fun readFirebase(file: File, packageName: String): Map<String, String> {
    fun invalid(): Nothing = throw IllegalArgumentException()
    try {
        if (!file.isFile || file.length() !in 1..262144) invalid()
        val config = JsonSlurper().parse(file, "UTF-8") as? Map<*, *> ?: invalid()
        val project = config["project_info"] as? Map<*, *> ?: invalid()
        val projectId = project["project_id"] as? String ?: invalid()
        val senderId = project["project_number"] as? String ?: invalid()
        if (!projectId.matches(Regex("[a-z][a-z0-9-]{4,28}[a-z0-9]")) || !senderId.matches(Regex("[0-9]{1,30}"))) invalid()
        val client = (config["client"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.singleOrNull {
            val info = it["client_info"] as? Map<*, *>
            val android = info?.get("android_client_info") as? Map<*, *>
            android?.get("package_name") == packageName
        } ?: invalid()
        val appId = (client["client_info"] as? Map<*, *>)?.get("mobilesdk_app_id") as? String ?: invalid()
        if (!appId.matches(Regex("1:${senderId}:android:[a-f0-9]+"))) invalid()
        val key = (client["api_key"] as? List<*>)?.filterIsInstance<Map<*, *>>()
            ?.mapNotNull { it["current_key"] as? String }?.singleOrNull() ?: invalid()
        if (!key.matches(Regex("AIza[A-Za-z0-9_-]{20,80}"))) invalid()
        return mapOf("FCM_PROJECT_ID" to projectId, "FCM_SENDER_ID" to senderId, "FCM_APP_ID" to appId, "FCM_API_KEY" to key)
    } catch (_: Exception) {
        val source = if (packageName == publicPackage) ".secrets/php-fcm/google-services-release.json"
            else "SURENECO_FCM_TRIAL_CONFIG or .secrets/php-fcm/google-services.json"
        throw GradleException("FCM client configuration for $packageName is missing or invalid. Check $source.")
    }
}

fun signingValue(name: String) = providers.gradleProperty(name).orElse(providers.environmentVariable(name)).orNull
    ?.takeIf { it.isNotBlank() }
val releaseStore = signingValue("SURENECO_PHP_RELEASE_STORE_FILE")?.let { rootProject.file(it) }
val releaseStorePassword = signingValue("SURENECO_PHP_RELEASE_STORE_PASSWORD")
val releaseAlias = signingValue("SURENECO_PHP_RELEASE_KEY_ALIAS")
val releaseKeyPassword = signingValue("SURENECO_PHP_RELEASE_KEY_PASSWORD")
val releaseSigningReady = releaseStore?.isFile == true && releaseStorePassword != null &&
    releaseAlias != null && releaseKeyPassword != null
val validatePublicSigning = tasks.register("validatePublicSigning") {
    doLast {
        if (!releaseSigningReady) throw GradleException("Public release signing requires SURENECO_PHP_RELEASE_STORE_FILE, SURENECO_PHP_RELEASE_STORE_PASSWORD, SURENECO_PHP_RELEASE_KEY_ALIAS and SURENECO_PHP_RELEASE_KEY_PASSWORD.")
    }
}
tasks.matching { it.name in setOf("packageRelease", "signReleaseBundle", "bundleRelease", "validateSigningRelease") }.configureEach {
    dependsOn(validatePublicSigning)
}

android {
    namespace = trialPackage
    compileSdk = 36
    defaultConfig {
        applicationId = trialPackage
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0-trial"
        manifestPlaceholders["appLabel"] = "スレネコ PHP・FCM試験"
    }
    signingConfigs {
        create("publicRelease") {
            storeFile = releaseStore
            storePassword = releaseStorePassword
            keyAlias = releaseAlias
            keyPassword = releaseKeyPassword
            storeType = "PKCS12"
        }
    }
    buildTypes {
        release {
            manifestPlaceholders["appLabel"] = "スレネコ PHP"
            signingConfig = signingConfigs.getByName("publicRelease")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
androidComponents {
    onVariants { variant ->
        val formal = variant.buildType == "release"
        val packageName = if (formal) publicPackage else trialPackage
        if (formal) {
            variant.applicationId.set(publicPackage)
            variant.outputs.forEach {
                it.versionName.set("0.14.0")
                it.versionCode.set(140)
            }
        }
        // Resolve only the configuration needed by the requested variant; don't package the JSON.
        val firebase by lazy { readFirebase(if (formal) releaseConfig else trialConfig.get(), packageName) }
        val fields = requireNotNull(variant.buildConfigFields)
        for (field in listOf("FCM_PROJECT_ID", "FCM_SENDER_ID", "FCM_APP_ID", "FCM_API_KEY")) {
            fields.put(field, providers.provider {
                BuildConfigField("String", "\"${firebase.getValue(field)}\"", null)
            })
        }
        fields.put("PUBLIC_SERVICE", BuildConfigField("boolean", formal.toString(), null))
    }
}
kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }
dependencies {
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    testImplementation("junit:junit:4.13.2")
}
