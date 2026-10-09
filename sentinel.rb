class Sentinel < Formula
  desc "Terminal PR reviewer for Bitbucket Server, powered by Juspay-hosted models"
  homepage "https://github.com/vishwajeetranaware105/sentinel"
  url "https://github.com/vishwajeetranaware105/sentinel.git", tag: "v0.1.1"
  version "0.1.1"
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
