Pod::Spec.new do |s|
  s.name         = 'BridgeKitExampleDemo'
  s.version      = '0.0.1'
  s.summary      = 'BridgeKit example demo wiring for iOS.'
  s.description  = 'Demo-only native providers and consumers for the BridgeKit React Native example app.'
  s.homepage     = 'https://github.com/malopezr7/bridgekit'
  s.license      = { :type => 'MIT' }
  s.author       = { 'malopezr7' => 'malopezr7@gmail.com' }
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  s.source_files = 'Sources/**/*.{swift,h,m,mm}'
  s.requires_arc = true

  s.dependency 'BridgeKit'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'SWIFT_OBJC_INTEROP_MODE' => 'objcxx',
    'DEFINES_MODULE' => 'YES'
  }
end
