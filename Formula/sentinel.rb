# Template: scripts/make-tap.sh fills in __URL__ / __REVISION__ and writes the real formula into a tap repo.
class Sentinel < Formula
  desc "Terminal PR reviewer for Bitbucket Server, powered by Juspay-hosted models"
  homepage "__HOMEPAGE__"
  url "__URL__", tag: "v__VERSION__", revision: "__REVISION__"
  version "__VERSION__"
  license :cannot_represent

  depends_on "node"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Run `sentinel` to open the reviewer. First launch walks you through setup:
        - your Bitbucket HTTP access token
        - your Juspay model gateway key
        - where to keep local copies of the repos you review
      Everything is stored in ~/.pr-sentinel (config is mode 600).
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/sentinel --version")
  end
end
