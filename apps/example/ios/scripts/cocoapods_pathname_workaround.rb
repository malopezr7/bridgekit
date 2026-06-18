# CocoaPods 1.16.2 can raise `pathname contains null byte` while generating
# Pods.xcodeproj in pnpm workspaces. Loading this file through RUBYOPT wraps
# Pathname#initialize without changing path values and avoids the failing code
# path observed with the Homebrew/Ruby CocoaPods executable.
require 'pathname'

class Pathname
  alias_method :bridgekit_original_initialize, :initialize unless method_defined?(:bridgekit_original_initialize)

  def initialize(path)
    bridgekit_original_initialize(path)
  end
end
