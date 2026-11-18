cask "sarala" do
  version "1.7.1"
  sha256 "3dd79d36af38075f32b317eee9ae2ad32ae957fd42f5357a0ef5e4cf2af62249"

  url "https://github.com/solancer/sarala/releases/download/v#{version}/Sarala_#{version}_universal.dmg"
  name "Sarala"
  desc "Seamless WYSIWYG Markdown editor"
  homepage "https://github.com/solancer/sarala"

  depends_on :macos

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
