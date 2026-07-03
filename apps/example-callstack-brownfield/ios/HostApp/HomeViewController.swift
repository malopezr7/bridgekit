import ReactNativeFramework
import UIKit

/// Native home screen — this is the "existing native app" side of the demo.
///
/// A button tap presents the React Native screen via Callstack brownfield.
/// Mirrors apps/example-expo-brownfield/ios/BridgeKitExpoBrownfield/HomeViewController.swift
/// but uses ReactNativeViewController (Callstack API) instead of ReactViewController.
///
/// ReactNativeViewController API verified:
///   Context7 /callstack/react-native-brownfield, "Instantiate ReactNativeViewController with Module Name"
///   `ReactNativeViewController(moduleName: "ReactNative")`
///
/// Module name "BridgeKitCallstackBrownfield" matches AppRegistry.registerComponent in index.js.

final class HomeViewController: UIViewController {

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Native Host"
    view.backgroundColor = .systemBackground
    setupUI()
  }

  // MARK: - UI

  private func setupUI() {
    let stack = UIStackView()
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
    ])

    let titleLabel = UILabel()
    titleLabel.text = "Existing Native App"
    titleLabel.font = .preferredFont(forTextStyle: .largeTitle)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 0
    stack.addArrangedSubview(titleLabel)

    let subtitleLabel = UILabel()
    subtitleLabel.text = "This screen is 100% native UIKit.\nTap the button to launch the React Native + BridgeKit demo."
    subtitleLabel.font = .preferredFont(forTextStyle: .body)
    subtitleLabel.textColor = .secondaryLabel
    subtitleLabel.textAlignment = .center
    subtitleLabel.numberOfLines = 0
    stack.addArrangedSubview(subtitleLabel)

    let button = UIButton(type: .system)
    button.setTitle("Open BridgeKit RN Demo", for: .normal)
    button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    button.addTarget(self, action: #selector(openRNDemo), for: .touchUpInside)
    stack.addArrangedSubview(button)
  }

  // MARK: - Actions

  /// Present the React Native screen.
  ///
  /// ReactNativeViewController is provided by ReactBrownfield (re-exported via
  /// ReactNativeFramework.swift using @_exported import ReactBrownfield).
  ///
  /// API verified: Context7 /callstack/react-native-brownfield docs/api-reference/react-native-brownfield/swift.mdx
  ///   `ReactNativeViewController(moduleName: "ReactNative")`
  @objc private func openRNDemo() {
    let vc = ReactNativeViewController(moduleName: "BridgeKitCallstackBrownfield")
    vc.modalPresentationStyle = .fullScreen
    present(vc, animated: true)
  }
}
