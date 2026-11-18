cask "sarala" do
  version "1.7.0"
  sha256 "507090f644dff65d82f5b9f87f83708d0ec4e4104c5f54e8358f6a4cb1286ac0"

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
