require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "BridgeKit"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "15.1" }
  # Release tags are package-scoped (see RELEASING.md): the core package ships as
  # `core-vX.Y.Z`, not a bare version, so a git-sourced pod must ask for that.
  s.source       = { :git => "https://github.com/malopezr7/bridgekit.git", :tag => "core-v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.exclude_files = "ios/__tests__/**/*"
  s.requires_arc = true

  load 'nitrogen/generated/ios/BridgeKit+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
