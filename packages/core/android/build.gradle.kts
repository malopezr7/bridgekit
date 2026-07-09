plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.react")
}

fun reactNativeArchitectures(): List<String> {
    val value = rootProject.properties["reactNativeArchitectures"] as? String
    return value?.split(",") ?: listOf("armeabi-v7a", "x86", "x86_64", "arm64-v8a")
}

// Resolve minSdk from the host app's rootProject.ext.minSdkVersion (matching how
// NitroModules resolves it) so BridgeKit's native build stays SDK-compatible with
// the consumer. Falls back to 24 for standalone builds.
fun resolveMinSdkVersion(): Int {
    return when (val value = rootProject.properties["minSdkVersion"]) {
        is Int -> value
        is String -> value.toInt()
        else -> 24
    }
}

apply(from = "../nitrogen/generated/android/BridgeKit+autolinking.gradle")
apply(from = "./fix-prefab.gradle")

android {
    namespace = "com.bridgekit"
    compileSdk = 35

    defaultConfig {
        minSdk = resolveMinSdkVersion()
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("boolean", "IS_NEW_ARCHITECTURE_ENABLED", "true")

        externalNativeBuild {
            cmake {
                cppFlags.addAll(
                    listOf(
                        "-frtti",
                        "-fexceptions",
                        "-Wall",
                        "-Wextra",
                        "-fstack-protector-all"
                    )
                )
                arguments.addAll(
                    listOf(
                        "-DANDROID_STL=c++_shared",
                        "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
                    )
                )
                abiFilters.addAll(reactNativeArchitectures())
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
        }
    }

    packagingOptions {
        resources {
            excludes.addAll(
                listOf(
                    "META-INF",
                    "META-INF/**"
                )
            )
        }
        jniLibs {
            excludes.addAll(
                listOf(
                    "**/libc++_shared.so",
                    "**/libfbjni.so",
                    "**/libjsi.so",
                    "**/libfolly_json.so",
                    "**/libfolly_runtime.so",
                    "**/libglog.so",
                    "**/libhermes.so",
                    "**/libhermes-executor-debug.so",
                    "**/libhermes_executor.so",
                    "**/libreactnative.so",
                    "**/libreactnativejni.so",
                    "**/libturbomodulejsijni.so",
                    "**/libreact_nativemodule_core.so",
                    "**/libjscexecutor.so"
                )
            )
        }
    }

    buildFeatures {
        buildConfig = true
        prefab = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    buildTypes {
        getByName("debug") {
            externalNativeBuild {
                cmake {
                    cppFlags.addAll(listOf("-O1", "-g"))
                }
            }
        }
        getByName("release") {
            isMinifyEnabled = false
            externalNativeBuild {
                cmake {
                    cppFlags.add("-O2")
                }
            }
        }
    }

    sourceSets {
        getByName("main") {
            // React Codegen files
            java.srcDir("${project.buildDir}/generated/source/codegen/java")
        }
        getByName("test") {
            val bridgekitGeneratedRuntimeTestDir =
                rootProject.properties["bridgekitGeneratedRuntimeTestDir"] as? String
            if (bridgekitGeneratedRuntimeTestDir != null) {
                val generatedRuntimeTestSourceDir = rootProject.file(bridgekitGeneratedRuntimeTestDir)
                if (!generatedRuntimeTestSourceDir.exists()) {
                    throw GradleException(
                        "bridgekitGeneratedRuntimeTestDir does not exist: $generatedRuntimeTestSourceDir"
                    )
                }
                val generatedRuntimeTestSources = fileTree(generatedRuntimeTestSourceDir) {
                    include("**/*.kt")
                }
                if (generatedRuntimeTestSources.isEmpty) {
                    throw GradleException(
                        "bridgekitGeneratedRuntimeTestDir contains no Kotlin fixture sources (*.kt): $generatedRuntimeTestSourceDir"
                    )
                }
                java.srcDir(generatedRuntimeTestSourceDir)
            }
        }
    }
}

dependencies {
    implementation(project(":react-native-nitro-modules"))
    // Coroutines — required by the BridgeKit core engine.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // React Native provided by host app — compileOnly to avoid version skew.
    compileOnly("com.facebook.react:react-android")

    // Test dependencies
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

tasks.matching { it.name.startsWith("externalNativeBuildClean") }.configureEach {
    dependsOn(":react-native-nitro-modules:prepareHeaders")
}

gradle.projectsEvaluated {
    val nitroModulesProject = project(":react-native-nitro-modules")
    nitroModulesProject.tasks.named("prepareHeaders").configure {
        mustRunAfter(nitroModulesProject.tasks.named("clean"))
    }
}
