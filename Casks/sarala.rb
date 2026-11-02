cask "sarala" do
  version "1.5.0"
  sha256 "becdbc125f15af9841cb3c9bc1b8ae0046c1f50a1802c5f8fbfee000aab608e7"

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
