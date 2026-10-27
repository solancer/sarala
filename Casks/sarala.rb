cask "sarala" do
  version "1.4.1"
  sha256 "6ff107607638c0ac76781d7b1697cea802cbe554bee00346695143f3334c0380"

  url "https://github.com/solancer/sarala/releases/download/v#{version}/Sarala_#{version}_universal.dmg"
  name "Sarala"
  desc "Seamless WYSIWYG Markdown editor"
  homepage "https://github.com/solancer/sarala"

  depends_on :macos

  # `version`/`sha256` above are bumped automatically by .github/workflows/release.yml.
  app "Sarala.app"

  # Sarala's universal binary is ad-hoc signed (so it runs on Apple Silicon) but is
  # NOT Apple-notarized. Strip the quarantine attribute Homebrew sets so Gatekeeper
  # doesn't block the first launch — this is why plain `brew install --cask sarala`
  # works with no extra flags. (The official homebrew/cask repo forbids this, which
  # is fine: this cask is served from a self-hosted tap, not submitted there.)
  # Declarative steps (Homebrew 5.1.14+): Homebrew 7 deprecates `postflight`.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Sarala.app"]
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
