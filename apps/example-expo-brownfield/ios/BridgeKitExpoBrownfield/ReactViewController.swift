import UIKit

/// Full-screen view controller that hosts the React Native root view.
/// The RN component registered as "BridgeKitExpoBrownfield" fills the entire
/// safe-area, mirroring how the Expo integrated-approach docs recommend embedding
/// (Context7 / docs/pages/brownfield/integrated-approach.mdx).
final class ReactViewController: UIViewController {

  private let factory: ReactNativeFactory

  init(factory: ReactNativeFactory) {
    self.factory = factory
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    // rootViewFactory.view(withModuleName:initialProperties:launchOptions:) is the
    // canonical Expo SDK 55 integrated-approach API (confirmed via Context7 docs).
    let rnView = factory.rootView(forModuleName: "BridgeKitExpoBrownfield")
    rnView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(rnView)

    NSLayoutConstraint.activate([
      rnView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      rnView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      rnView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      rnView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
    ])

    // Close button so users can return to the native home screen.
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .close,
      target: self,
      action: #selector(dismiss(_:))
    )
  }

  @objc private func dismiss(_ sender: Any) {
    dismiss(animated: true)
  }
}
