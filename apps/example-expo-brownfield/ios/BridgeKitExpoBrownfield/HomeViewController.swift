import UIKit

/// Native home screen — this is the "existing native app" side of the demo.
/// A button tap presents the React Native screen embedded via Expo.
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
    subtitleLabel.text = "This screen is 100% native UIKit.\nTap the button to embed the React Native + BridgeKit demo."
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

  @objc private func openRNDemo() {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    let vc = ReactViewController(factory: appDelegate.rnFactory)
    vc.modalPresentationStyle = .fullScreen
    present(vc, animated: true)
  }
}
