import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release signing key lives outside the repository (~/.reddate/keystore.properties); without it
// a release build is simply left unsigned.
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".reddate/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Where the app loads Reddate from. Release builds use the live site; debug builds
// default to the Android emulator's "host computer" address, and can be pointed at a
// computer on your Wi-Fi with:  ./gradlew installDebug -PstartUrl=http://192.168.1.20:3090/?tv=1
val liveUrl = "https://tv.reddate.xyz/?tv=1"
val debugUrl = (project.findProperty("startUrl") as String?) ?: "http://10.0.2.2:3090/?tv=1"

android {
    namespace = "xyz.reddate.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "xyz.reddate.tv"
        minSdk = 23
        targetSdk = 34
        versionCode = 45
        versionName = "0.4.5"
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = File(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "START_URL", "\"$debugUrl\"")
        }
        release {
            buildConfigField("String", "START_URL", "\"$liveUrl\"")
            // R8 optimises the code (Compose runs noticeably smoother) and drops what's unused; see proguard-rules.pro.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        // A fast build for trying on a TV over the local network: not debuggable (so it runs at
        // release speed), signed with the debug key, pointed at -PstartUrl like the debug build.
        create("lan") {
            initWith(getByName("release"))
            buildConfigField("String", "START_URL", "\"$debugUrl\"")
            signingConfig = signingConfigs.getByName("debug")
            isDebuggable = false
            matchingFallbacks += listOf("release")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14" // matches Kotlin 1.9.24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Native video player (MKV, HEVC, DTS… everything the TV's hardware can decode).
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-exoplayer-dash:1.4.1")
    implementation("androidx.media3:media3-exoplayer-smoothstreaming:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    // QR code for the invite panel (encoding only, no camera).
    implementation("com.google.zxing:core:3.5.3")

    // Native TV screens: Jetpack Compose for TV (the same toolkit Nuvio TV uses), images with Coil.
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.tv:tv-material:1.0.0")
    implementation("io.coil-kt:coil-compose:2.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
}
