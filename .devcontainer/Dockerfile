# syntax=docker/dockerfile:1.7
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG TARGETARCH
ARG UV_VERSION=0.11.23

# The Debian snapshot timestamp is immutable. Package names resolve against
# that fixed archive rather than today's mutable apt indexes.
RUN printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250908T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20250908T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spec-tools
COPY .devcontainer/package.json .devcontainer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && node node_modules/@anthropic-ai/claude-code/install.cjs \
    && ln -s /opt/spec-tools/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -s /opt/spec-tools/node_modules/.bin/pnpm /usr/local/bin/pnpm

# uv release assets are selected per architecture and verified before extract.
RUN node - <<'NODE'
const fs = require('node:fs')
const https = require('node:https')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const arch = process.env.TARGETARCH
const assets = {
  arm64: ['aarch64-unknown-linux-gnu', '1873a77350f6621279ae1a0d2227f2bd8b67131598f14a7eb0ba2215d3da2c98'],
  amd64: ['x86_64-unknown-linux-gnu', 'e12c4cda2fe8c305510a78380a88f2c32a27e90cdcd123cefd2873388f0ebb5f'],
}
if (!assets[arch]) throw new Error(`unsupported TARGETARCH ${arch}`)
const [target, expected] = assets[arch]
const destination = '/tmp/uv.tar.gz'
const download = (url, redirects = 0) => new Promise((resolve, reject) => {
  https.get(url, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 8) {
      response.resume()
      return resolve(download(response.headers.location, redirects + 1))
    }
    if (response.statusCode !== 200) return reject(new Error(`download failed: ${response.statusCode}`))
    const output = fs.createWriteStream(destination)
    response.pipe(output)
    output.on('finish', () => output.close(resolve))
  }).on('error', reject)
})
;(async () => {
  await download(`https://github.com/astral-sh/uv/releases/download/${process.env.UV_VERSION}/uv-${target}.tar.gz`)
  const actual = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
  if (actual !== expected) throw new Error(`uv checksum mismatch: ${actual}`)
  cp.execFileSync('tar', ['-xzf', destination, '-C', '/tmp'])
  fs.copyFileSync(`/tmp/uv-${target}/uv`, '/usr/local/bin/uv')
  fs.chmodSync('/usr/local/bin/uv', 0o755)
})().catch(error => { console.error(error); process.exit(1) })
NODE

ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_CACHE_DIR=/home/node/.cache/uv \
    UV_PYTHON_CACHE_DIR=/home/node/.cache/uv \
    UV_NO_PROGRESS=1 \
    PATH=/opt/spec-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
RUN UV_CACHE_DIR=/tmp/uv-cache UV_PYTHON_CACHE_DIR=/tmp/uv-cache uv python install 3.13.7 \
    && rm -rf /tmp/uv-cache

USER node
WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
