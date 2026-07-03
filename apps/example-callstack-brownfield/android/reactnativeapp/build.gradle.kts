import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import com.callstack.react.brownfield.utils.Extension as ReactBrownfieldExtension
import java.io.ByteArrayOutputStream

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    // com.facebook.react is applied BEFORE brownfield so autolinkLibrariesWithApp()
    // can pull BridgeKit + react-native-nitro-modules into the AAR via the RN Gradle Plugin.
    id("com.facebook.react")
    // Brownfield plugin — adds the 'package:android' / 'publish:android' Gradle tasks.
    id("com.callstack.react.brownfield")
    `maven-publish`
}

fun resolveNodePackageDir(packageName: String): String {
    val output = ByteArrayOutputStream()
    val error = ByteArrayOutputStream()
    exec {
        workingDir = rootDir.parentFile
        commandLine("node", "--print", "require.resolve('$packageName/package.json')")
        standardOutput = output
        errorOutput = error
    }
    val resolvedPackageJson = output.toString().trim()
    require(resolvedPackageJson.isNotBlank()) {
        "Could not resolve $packageName from ${rootDir.parentFile}: ${error.toString().trim()}"
    }
    return file(resolvedPackageJson).parentFile.absolutePath
}

react {
    hermesCommand = "${resolveNodePackageDir("hermes-compiler")}/hermesc/%OS-BIN%/hermesc"
    // Pulls every autolinked native module (BridgeKit, Nitro) into the AAR. No manual C++.
    autolinkLibrariesWithApp()
}

extensions.configure<ReactBrownfieldExtension>("reactBrownfield") {
    appProjectName = "reactnativeapp"
}

fun registerBundleTask(variantName: String, dev: Boolean) {
    val taskName = "createBundle${variantName}JsAndAssets"
    val assetsDir = layout.buildDirectory.dir("generated/assets/$taskName")
    val resDir = layout.buildDirectory.dir("generated/res/$taskName")
    val reactNativeCli = "${resolveNodePackageDir("react-native")}/cli.js"

    tasks.register<Exec>(taskName) {
        workingDir = rootDir.parentFile

        inputs.file(rootDir.parentFile.resolve("index.js"))
        inputs.dir(rootDir.parentFile.resolve("src"))
        inputs.file(rootDir.parentFile.resolve("package.json"))
        outputs.dir(assetsDir)
        outputs.dir(resDir)

        doFirst {
            assetsDir.get().asFile.mkdirs()
            resDir.get().asFile.mkdirs()
        }

        commandLine(
            "node",
            reactNativeCli,
            "bundle",
            "--platform",
            "android",
            "--dev",
            dev.toString(),
            "--entry-file",
            "index.js",
            "--bundle-output",
            assetsDir.get().file("index.android.bundle").asFile.absolutePath,
            "--assets-dest",
            resDir.get().asFile.absolutePath,
        )
    }
}

registerBundleTask("Debug", dev = true)
registerBundleTask("Release", dev = false)

tasks.register("generateAutolinkingPackageList") {
    val outputDir = layout.buildDirectory.dir("generated/autolinking/src/main/java")
    outputs.dir(outputDir)
    doLast {
        outputDir.get().asFile.mkdirs()
    }
}

// The Callstack brownfield plugin assumes appProjectName points to a separate
// Android app. In this sample the RN packager module is the AAR module itself,
// because the native host consumes the published AAR and does not apply the RN
// Gradle plugin. Remove the plugin's self-referential JNI-copy dependencies:
// copyReleaseLibSources -> stripReleaseDebugSymbols -> mergeReleaseJniLibFolders
// -> copyReleaseLibSources.
gradle.projectsEvaluated {
    val copyLibSourceTasks = tasks.matching { it.name.matches(Regex("copy.*LibSources")) }

    copyLibSourceTasks.configureEach {
        val selfTaskPrefix = ":${project.name}:"
        setDependsOn(dependsOn.filterNot { dependency ->
            val dependencyPath = dependency.toString()
            dependencyPath.startsWith(selfTaskPrefix) &&
                (dependencyPath.contains(":strip") ||
                    dependencyPath.endsWith(":generateCodegenSchemaFromJavaScript"))
        })
    }

    tasks.named("generateCodegenSchemaFromJavaScript").configure {
        dependsOn(copyLibSourceTasks)
    }
}

android {
    ndkVersion = rootProject.extra["ndkVersion"] as String
    buildToolsVersion = rootProject.extra["buildToolsVersion"] as String
    compileSdk = (rootProject.extra["compileSdkVersion"] as Int)

    namespace = "com.bridgekit.callstackbrownfield"

    defaultConfig {
        minSdk = (rootProject.extra["minSdkVersion"] as Int)
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    // Required by brownfield's publish:android to expose all build variants.
    publishing {
        multipleVariants {
            allVariants()
        }
    }
}

dependencies {
    // The RN root Gradle plugin is intentionally not applied in this two-module
    // brownfield project, so pin the artifacts explicitly instead of relying on
    // root-plugin dependency substitution.
    api("com.facebook.react:react-android:0.83.6")
    api("com.facebook.hermes:hermes-android:0.14.1")
}

// ---------------------------------------------------------------------------
// Maven publishing — used by `brownfield publish:android --module-name reactnativeapp`
// to push the AAR into mavenLocal() so the :host app can consume it.
// ---------------------------------------------------------------------------
publishing {
    publications {
        create<MavenPublication>("mavenAar") {
            groupId = "com.bridgekit"
            artifactId = "reactnativeapp"
            version = "1.0.0"
            afterEvaluate {
                from(components.getByName("default"))
            }

            pom {
                withXml {
                    val dependenciesNode = (asNode().get("dependencies") as groovy.util.NodeList).first() as groovy.util.Node
                    dependenciesNode.children()
                        .filterIsInstance<groovy.util.Node>()
                        .filter { (it.get("groupId") as groovy.util.NodeList).text() == rootProject.name }
                        .forEach { dependenciesNode.remove(it) }
                }
            }
        }
    }

    repositories {
        mavenLocal()
    }
}

val moduleBuildDir: Directory = layout.buildDirectory.get()

tasks.register("removeDependenciesFromModuleFile") {
    doLast {
        file("$moduleBuildDir/publications/mavenAar/module.json").run {
            val json = inputStream().use { JsonSlurper().parse(it) as Map<String, Any> }
            (json["variants"] as? List<MutableMap<String, Any>>)?.forEach { variant ->
                (variant["dependencies"] as? MutableList<Map<String, Any>>)?.removeAll { it["group"] == rootProject.name }
            }
            writer().use { it.write(JsonOutput.prettyPrint(JsonOutput.toJson(json))) }
        }
    }
}

tasks.named("generateMetadataFileForMavenAarPublication") {
    finalizedBy("removeDependenciesFromModuleFile")
}
