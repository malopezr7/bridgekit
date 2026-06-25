#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'pathname'
require 'xcodeproj'
require 'open3'

core_root = Pathname.new(File.expand_path('..', __dir__))
project_dir = core_root + 'ios-xcframework'
project_path = project_dir + 'BridgeKitXCFramework.xcodeproj'

def node_resolve_package(package_name, from:)
  stdout, stderr, status = Open3.capture3(
    'node',
    '-p',
    "require.resolve('#{package_name}/package.json', {paths: [process.argv[1]]})",
    from.to_s
  )
  abort stderr unless status.success?
  Pathname.new(File.dirname(stdout.strip))
end

nitro_root = node_resolve_package('react-native-nitro-modules', from: core_root)

FileUtils.mkdir_p(project_dir)
FileUtils.rm_rf(project_path)

# Nitro's CocoaPods public framework exposes public headers that quote-include
# private implementation headers. Adding broad Nitro source folders to
# HEADER_SEARCH_PATHS makes Clang see duplicate copies of the public headers and
# causes C++ redefinition errors. Keep a flattened shim with Nitro's non-public
# headers only, so quote-includes can resolve without duplicating module-map
# public headers.
nitro_private_header_dir = project_dir + 'NitroPrivateHeaders'
FileUtils.rm_rf(nitro_private_header_dir)
FileUtils.mkdir_p(nitro_private_header_dir)

nitro_public_header_names = %w[
  AnyMap.hpp
  AnyMapUtils.hpp
  ArrayBuffer.hpp
  ArrayBufferHolder.hpp
  CachedProp.hpp
  DateToChronoDate.hpp
  Dispatcher.hpp
  FastVectorCopy.hpp
  HybridNitroModulesProxy.hpp
  HybridObject.hpp
  HybridObjectRegistry.hpp
  InstallNitro.hpp
  JSCallback.hpp
  JSIConverter.hpp
  JSIHelpers.hpp
  NitroDefines.hpp
  NitroHash.hpp
  NitroLogger.hpp
  Null.hpp
  Promise.hpp
  PromiseHolder.hpp
  PropNameIDCache.hpp
  Result.hpp
  RuntimeError.hpp
  SwiftClosure.hpp
]

nitro_header_sources = [
  *(nitro_root + 'cpp').glob('**/*.{h,hpp}', File::FNM_EXTGLOB),
  *(nitro_root + 'ios').glob('**/*.{h,hpp}', File::FNM_EXTGLOB)
]

nitro_header_sources.each do |source|
  next if nitro_public_header_names.include?(source.basename.to_s)

  FileUtils.cp(source, nitro_private_header_dir + source.basename)
end

project = Xcodeproj::Project.new(project_path.to_s)
project.root_object.attributes['LastSwiftUpdateCheck'] = '2600'
project.root_object.attributes['LastUpgradeCheck'] = '2600'
project.root_object.attributes['BuildIndependentTargetsInParallel'] = 'YES'

framework = project.new_target(:framework, 'BridgeKit', :ios, '15.1')
framework.product_reference.name = 'BridgeKit.framework'
framework.product_reference.path = 'BridgeKit.framework'

host = project.new_target(:application, 'BridgeKitBuildHost', :ios, '15.1')
host.product_reference.name = 'BridgeKitBuildHost.app'
host.product_reference.path = 'BridgeKitBuildHost.app'

project.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
  config.build_settings['CLANG_CXX_LIBRARY'] = 'libc++'
end

common_framework_settings = {
  'PRODUCT_NAME' => 'BridgeKit',
  'PRODUCT_BUNDLE_IDENTIFIER' => 'com.bridgekit.runtime',
  'DEFINES_MODULE' => 'YES',
  'GENERATE_INFOPLIST_FILE' => 'YES',
  'BUILD_LIBRARY_FOR_DISTRIBUTION' => 'YES',
  'SKIP_INSTALL' => 'NO',
  'SWIFT_VERSION' => '5.0',
  'SWIFT_OBJC_INTEROP_MODE' => 'objcxx',
  'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  'CLANG_CXX_LIBRARY' => 'libc++',
  'CLANG_ENABLE_MODULES' => 'YES',
  'ENABLE_MODULE_VERIFIER' => 'NO',
  'ENABLE_USER_SCRIPT_SANDBOXING' => 'NO',
  'APPLICATION_EXTENSION_API_ONLY' => 'NO',
  'MACH_O_TYPE' => 'mh_dylib',
  'GCC_PREPROCESSOR_DEFINITIONS' => ['$(inherited)', 'BRIDGEKIT_BUILDING_XCFRAMEWORK=1'],
  'HEADER_SEARCH_PATHS' => [
    '$(inherited)',
    '$(SRCROOT)/../nitrogen/generated/shared/c++',
    '$(SRCROOT)/../nitrogen/generated/ios',
    '$(SRCROOT)/../nitrogen/generated/ios/c++',
    '$(PODS_ROOT)/Headers/Private/NitroModules',
    '$(SRCROOT)/NitroPrivateHeaders'
  ],
  'OTHER_LDFLAGS' => ['$(inherited)', '-ObjC', '-lc++'],
  'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']
}

framework.build_configurations.each do |config|
  config.build_settings.merge!(common_framework_settings)
  config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = config.name == 'Debug' ? '-Onone' : '-O'
end

host.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.bridgekit.xcframework.buildhost',
    'INFOPLIST_FILE' => 'BridgeKitBuildHost/Info.plist',
    'SWIFT_VERSION' => '5.0',
    'CLANG_ENABLE_MODULES' => 'YES',
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'NO',
    'SKIP_INSTALL' => 'YES'
  )
  config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = config.name == 'Debug' ? '-Onone' : '-O'
end

sources_group = project.main_group.new_group('BridgeKitSources')
host_group = project.main_group.new_group('BridgeKitBuildHost')

# Public umbrella header only; do not publish Nitro/C++ generated headers.
umbrella_ref = project.main_group.new_file('BridgeKit.h')
umbrella_build_file = framework.headers_build_phase.add_file_reference(umbrella_ref)
umbrella_build_file.settings = { 'ATTRIBUTES' => ['Public'] }

source_globs = [
  'ios/**/*.{swift,m,mm,cpp}',
  'nitrogen/generated/shared/c++/**/*.{cpp}',
  'nitrogen/generated/ios/**/*.{swift,mm,cpp}'
]
exclude_patterns = [
  %r{/ios/__tests__/},
  %r{/nitrogen/generated/android/}
]

source_globs.flat_map { |pattern| Dir.glob((core_root + pattern).to_s, File::FNM_EXTGLOB) }
            .sort
            .each do |absolute|
  next if exclude_patterns.any? { |pattern| absolute.match?(pattern) }

  relative = Pathname.new(absolute).relative_path_from(project_dir).to_s
  ref = sources_group.new_file(relative)
  framework.add_file_references([ref])
end

Dir.glob((project_dir + 'BridgeKitBuildHost/**/*.{swift,m,mm,cpp}').to_s, File::FNM_EXTGLOB).sort.each do |absolute|
  relative = Pathname.new(absolute).relative_path_from(project_dir).to_s
  ref = host_group.new_file(relative)
  host.add_file_references([ref])
end

# Shared scheme used by xcodebuild archive after `pod install` creates the workspace.
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(framework)
scheme.save_as(project_path, 'BridgeKit', true)

project.save
puts "Generated #{project_path}"
