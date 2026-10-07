# Template: bump-cask.sh fills in @VERSION@ and @SHA256@ and writes the cask
# into the tap (github.com/Lucanepa/homebrew-tap, Casks/openbeach.rb).
cask "openbeach" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/Lucanepa/openvolley/releases/download/beach-desktop-v#{version}/OpenBeach_#{version}_universal.dmg",
      verified: "github.com/Lucanepa/openvolley/"
  name "OpenBeach"
  desc "Offline beach volleyball e-scoresheet and LAN server for referee tablets"
  homepage "https://get.openvolley.app/#openbeach"

  livecheck do
    url "https://get.openvolley.app/desktop/beach/latest.json"
    strategy :json do |json|
      json["version"]
    end
  end

  # The app updates itself (signed updates, installed when the scorer quits).
  auto_updates true
  depends_on macos: ">= :big_sur"

  app "OpenBeach.app"

  # The match backups (~/Library/Application Support/OpenBeach) stay.
  zap trash: [
    "~/Library/Application Support/com.openvolley.beach",
    "~/Library/Caches/com.openvolley.beach",
    "~/Library/Logs/OpenBeach",
    "~/Library/Preferences/com.openvolley.beach.plist",
    "~/Library/Saved Application State/com.openvolley.beach.savedState",
    "~/Library/WebKit/com.openvolley.beach",
  ]

  caveats <<~EOS
    OpenBeach is not notarized by Apple, so macOS blocks its first start.
    Open it once, then System Settings > Privacy & Security > Open Anyway.
    Or in Terminal:
      xattr -dr com.apple.quarantine /Applications/OpenBeach.app
  EOS
end
