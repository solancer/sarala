cask "sarala" do
  version "1.1.0"
  sha256 "faff6c62f1f61f6518f9448c0de498590e847a90641d15bc6a0db4ed55c93e0a"

  url "https://github.com/solancer/sarala/releases/download/v#{version}/Sarala_#{version}_universal.dmg"
  name "Sarala"
  desc "Seamless WYSIWYG Markdown editor"
  homepage "https://github.com/solancer/sarala"

  depends_on macos: :catalina

  # `version`/`sha256` above are bumped automatically by .github/workflows/release.yml.
  app "Sarala.app"

  # Sarala's universal binary is ad-hoc signed (so it runs on Apple Silicon) but is
  # NOT Apple-notarized. Strip the quarantine attribute Homebrew sets so Gatekeeper
  # doesn't block the first launch — this is why plain `brew install --cask sarala`
  # works with no extra flags. (The official homebrew/cask repo forbids this, which
  # is fine: this cask is served from a self-hosted tap, not submitted there.)
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Sarala.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.srinivasgowda.sarala",
    "~/Library/Caches/com.srinivasgowda.sarala",
    "~/Library/HTTPStorages/com.srinivasgowda.sarala",
    "~/Library/Preferences/com.srinivasgowda.sarala.plist",
    "~/Library/Saved Application State/com.srinivasgowda.sarala.savedState",
    "~/Library/WebKit/com.srinivasgowda.sarala",
  ]
end
