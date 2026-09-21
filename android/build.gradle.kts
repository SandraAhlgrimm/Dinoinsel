plugins {
    id("com.android.application") version "8.9.1"
}

val gradleManifestDirectory = layout.buildDirectory.dir("gradle-manifest")
val prepareGradleManifest by tasks.registering(Copy::class) {
    from("src/main/AndroidManifest.xml")
    into(gradleManifestDirectory)
    filter { line -> line.replace("package=\"de.dinoinsel.game\"", "") }
}

android {
    namespace = "de.dinoinsel.game"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.dinoinsel.game"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    sourceSets["main"].assets.srcDir("../game")
    sourceSets["main"].manifest.srcFile(
        gradleManifestDirectory.map { it.file("AndroidManifest.xml") }
    )

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    signingConfigs.getByName("debug") {
        storeFile = file("../../.android-tools/signing/gradle-debug.keystore")
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    tasks.named("preBuild") {
        dependsOn(prepareGradleManifest)
    }
}
