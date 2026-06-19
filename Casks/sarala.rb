cask "sarala" do
  version "0.2.1"
  sha256 "6d59066a2ee9171ceef9eebf5ce9786e72ffdf487649b7ff7b6fa3c4642f5f65"

  url "https://github.com/solancer/sarala/releases/download/v#{version}/Sarala_#{version}_universal.dmg"
  name "Sarala"
  desc "Seamless WYSIWYG Markdown editor"
  homepage "https://github.com/solancer/sarala"

  depends_on macos: :catalina

  # Sarala's universal binary is ad-hoc signed (so it runs on Apple Silicon) but
  # is NOT Apple-notarized. Install with `--no-quarantine` so Gatekeeper doesn't
  # block the first launch:
  #   brew install --cask --no-quarantine sarala
  # `version`/`sha256` above are bumped automatically by .github/workflows/release.yml.
  app "Sarala.app"

  zap trash: [
    "~/Library/Application Support/com.srinivasgowda.sarala",
    "~/Library/Caches/com.srinivasgowda.sarala",
    "~/Library/HTTPStorages/com.srinivasgowda.sarala",
    "~/Library/Preferences/com.srinivasgowda.sarala.plist",
    "~/Library/Saved Application State/com.srinivasgowda.sarala.savedState",
    "~/Library/WebKit/com.srinivasgowda.sarala",
  ]
end
