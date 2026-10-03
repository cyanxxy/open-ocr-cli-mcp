import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tarball, output = 'open-ocr-cli.rb'] = process.argv.slice(2);
if (!tarball) throw new Error('Usage: node scripts/render-homebrew-formula.mjs <tarball> [output]');
const packageJson = JSON.parse(readFileSync(path.resolve('packages/cli/package.json'), 'utf8'));
const version = packageJson.version;
const tarballPath = path.resolve(tarball);
const expectedTarballName = `open-ocr-cli-${version}.tgz`;
if (path.basename(tarballPath) !== expectedTarballName) {
  throw new Error(`Expected the ${version} package tarball ${expectedTarballName}, received ${path.basename(tarballPath)}`);
}
const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
const formula = `class OpenOcrCli < Formula
  desc "Provider-neutral multimodal OCR for files, URLs, and document pipelines"
  homepage "https://github.com/cyanxxy/open-ocr-cli-mcp"
  url "https://registry.npmjs.org/open-ocr-cli/-/open-ocr-cli-${version}.tgz"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "--global", "--prefix", libexec, "."
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/open-ocr-cli --version")
    assert_match "openrouter", shell_output("#{bin}/open-ocr-cli providers --json")
  end
end
`;
writeFileSync(path.resolve(output), formula);
process.stdout.write(`${path.resolve(output)}\n`);
