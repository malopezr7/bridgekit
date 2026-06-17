plugins {
    id("common-android-feature")
    id("com.facebook.react")
}

fun reactNativeArchitectures(): List<String> {
    val value = rootProject.properties["reactNativeArchitectures"] as? String
    return value?.split(",") ?: listOf("armeabi-v7a", "x86", "x86_64", "arm64-v8a")
}

apply(from = "../nitrogen/generated/android/BridgeKit+autolinking.gradle")
apply(from = "./fix-prefab.gradle")

android {
    namespace = "com.bridgekit"

    defaultConfig {
        consumerProguardFiles("consumer-rules.pro")
    }

    defaultConfig {
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
    }
}

dependencies {
    implementation(project(":react-native-nitro-modules"))
    // Coroutines — required by the BridgeKit core engine.
    // Version aligned with the Kotlin version used in the build-logic.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

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
