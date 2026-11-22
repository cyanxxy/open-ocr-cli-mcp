import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function renderHomebrewFormula({ version, sha256 }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Invalid formula version ${version}`);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('The formula sha256 must be 64 lowercase hex characters');
  // Homebrew deletes the build directory after install, and `npm install` of a
  // directory only links back to it without installing dependencies. Homebrew's
  // std_npm_args packs the staged package into a tarball first (dropping the
  // prepack build) and installs that, with its dependencies, into libexec.
  return `class OpenOcrCli < Formula
  desc "Provider-neutral multimodal OCR for files, URLs, and document pipelines"
  homepage "https://github.com/cyanxxy/open-ocr-cli-mcp"
  url "https://registry.npmjs.org/open-ocr-cli/-/open-ocr-cli-${version}.tgz"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/open-ocr-cli --version")
    assert_match "openrouter", shell_output("#{bin}/open-ocr-cli providers --json")
  end
end
`;
}

function main() {
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
  writeFileSync(path.resolve(output), renderHomebrewFormula({ version, sha256 }));
  process.stdout.write(`${path.resolve(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
