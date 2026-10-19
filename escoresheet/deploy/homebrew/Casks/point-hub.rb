# Template: bump-cask.sh --app point-hub fills in @VERSION@, @SHA256_ARM64@, @SHA256_X64@ and @APP@
# (the bundle in the disk images) and writes the cask into the tap (Casks/point-hub.rb).
cask "point-hub" do
  arch arm: "arm64", intel: "x64"

  version "@VERSION@"
  sha256 arm:   "@SHA256_ARM64@",
         intel: "@SHA256_X64@"

  url "https://github.com/Lucanepa/point-hub/releases/download/desktop-v#{version}/Point-Hub-#{version}-macos-#{arch}.dmg",
      verified: "github.com/Lucanepa/point-hub/"
  name "Point Hub"
  desc "Console of the LedBox scoreboard"
  homepage "https://github.com/Lucanepa/point-hub"

  # Its desktop releases are GitHub's "Latest" of that repo, tagged desktop-v<version>.
  livecheck do
    url :url
    regex(/^desktop-v?(\d+(?:\.\d+)+)$/i)
    strategy :github_latest
  end

  # Chromium in its runtime needs macOS 12; the bundle says so too (LSMinimumSystemVersion).
  depends_on macos: ">= :monterey"

  # No auto_updates: Point Hub has no updater, `brew upgrade` brings each version.
  app "@APP@"

  # The settings and the game backups (~/Library/Application Support/Point Hub) stay.
  zap trash: [
    "~/Library/Caches/ch.kscw.pointhub",
    "~/Library/Preferences/ch.kscw.pointhub.plist",
    "~/Library/Saved Application State/ch.kscw.pointhub.savedState",
  ]

  caveats <<~EOS
    Point Hub is not notarized by Apple, so macOS blocks its first start.
    Open it once, then System Settings > Privacy & Security > Open Anyway.
    Or in Terminal:
      xattr -dr com.apple.quarantine "/Applications/@APP@"
  EOS
end
