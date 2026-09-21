plugins {
    id("com.android.application") version "8.9.1"
}

val gradleInputs = layout.buildDirectory.dir("gradle-inputs")
val prepareGradleInputs by tasks.registering(Exec::class) {
    inputs.files("runtime_config.py", "../game/index.html", "src/main/AndroidManifest.xml")
    inputs.file("src/main/assets/native-network.js")
    outputs.dir(gradleInputs)
    environment("PYTHONDONTWRITEBYTECODE", "1")
    commandLine("python3", "runtime_config.py", "--gradle")
}

android {
    namespace = "de.dinoinsel.game"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.dinoinsel.game"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.2"
    }

    sourceSets["main"].assets.setSrcDirs(listOf(gradleInputs.map { it.dir("assets") }))
    sourceSets["main"].manifest.srcFile(
        gradleInputs.map { it.file("AndroidManifest.xml") }
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
        dependsOn(prepareGradleInputs)
    }
}
