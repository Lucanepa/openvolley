# Template: bump-cask.sh fills in @VERSION@ and @SHA256@ and writes the cask
# into the tap (github.com/Lucanepa/homebrew-tap, Casks/openvolley.rb).
cask "openvolley" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/Lucanepa/openvolley/releases/download/desktop-v#{version}/OpenVolley.eScoresheet_#{version}_universal.dmg",
      verified: "github.com/Lucanepa/openvolley/"
  name "OpenVolley eScoresheet"
  desc "Offline volleyball e-scoresheet and LAN server for referee and livescore tablets"
  homepage "https://get.openvolley.app/"

  livecheck do
    url "https://get.openvolley.app/desktop/latest.json"
    strategy :json do |json|
      json["version"]
    end
  end

  # The app updates itself (signed updates, installed when the scorer quits).
  auto_updates true
  depends_on macos: ">= :big_sur"

  app "OpenVolley eScoresheet.app"

  # The match backups (~/Library/Application Support/OpenVolley) stay.
  zap trash: [
    "~/Library/Application Support/com.openvolley.escoresheet",
    "~/Library/Caches/com.openvolley.escoresheet",
    "~/Library/Logs/OpenVolley",
    "~/Library/Preferences/com.openvolley.escoresheet.plist",
    "~/Library/Saved Application State/com.openvolley.escoresheet.savedState",
    "~/Library/WebKit/com.openvolley.escoresheet",
  ]

  caveats <<~EOS
    OpenVolley eScoresheet is not notarized by Apple, so macOS blocks its
    first start. Open it once, then System Settings > Privacy & Security >
    Open Anyway. Or in Terminal:
      xattr -dr com.apple.quarantine "/Applications/OpenVolley eScoresheet.app"
  EOS
end
