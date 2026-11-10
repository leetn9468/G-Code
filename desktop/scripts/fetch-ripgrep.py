#!/usr/bin/env python3
"""Fetch the pinned official ripgrep release for the desktop bundle.

Grep and Glob use this binary through GCODE_RG_PATH, so a Mac without a PATH
ripgrep never falls back to the slow walk. Only the pinned BurntSushi/ripgrep
release archive is downloaded; its SHA-256 comes from the release's .sha256 asset.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

RECIPE_VERSION = 1
VERSION = '15.2.0'
ARCHIVE_SHA256 = {
    'aarch64-apple-darwin': '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
    'x86_64-apple-darwin': 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
}
LICENSES = ('COPYING', 'LICENSE-MIT', 'UNLICENSE')
ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def target_triple():
    # Tauri passes the bundle target to before*Command; a plain run uses the host.
    triple = os.environ.get('TAURI_ENV_TARGET_TRIPLE')
    if not triple:
        if platform.system() != 'Darwin':
            raise SystemExit('The bundled ripgrep recipe targets macOS.')
        triple = {'arm64': 'aarch64', 'x86_64': 'x86_64'}.get(platform.machine(), platform.machine()) + '-apple-darwin'
    if triple not in ARCHIVE_SHA256:
        raise SystemExit(f'No pinned ripgrep {VERSION} archive for {triple}')
    return triple


def write_public_notice(destination, source_url):
    # The Settings notices viewer reads this copy; the bundle keeps the originals.
    notice = ROOT / 'public' / 'licenses' / 'ripgrep-LICENSES.txt'
    text = f'ripgrep {VERSION} (MIT OR Unlicense)\nSource: {source_url}\n\n' + '\n'.join(
        f'===== {name} =====\n\n{(destination / name).read_text()}' for name in LICENSES)
    notice.parent.mkdir(parents=True, exist_ok=True)
    if not notice.is_file() or notice.read_text() != text:
        notice.write_text(text)


def signature_ok(binary):
    return subprocess.run(['codesign', '--verify', '--strict', str(binary)], capture_output=True).returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--if-needed', action='store_true', help='Reuse the binary when its manifest and SHA-256 match.')
    args = parser.parse_args()
    triple = target_triple()
    archive_sha256 = ARCHIVE_SHA256[triple]
    destination = ROOT / 'runtime' / 'ripgrep'
    final = destination / 'bin' / 'rg'
    manifest_path = destination / 'runtime-manifest.json'
    if args.if_needed and final.is_file() and manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
            if (manifest.get('recipe_version') == RECIPE_VERSION
                    and manifest.get('version') == VERSION
                    and manifest.get('target') == triple
                    and manifest.get('archive_sha256') == archive_sha256
                    and manifest.get('binary_sha256') == sha256(final)
                    and all((destination / name).is_file() for name in LICENSES)
                    and signature_ok(final)):
                write_public_notice(destination, manifest.get('source_url') or f'https://github.com/BurntSushi/ripgrep/releases/tag/{VERSION}')
                print(f'Using verified ripgrep {VERSION}: {final}')
                return
        except (OSError, ValueError):
            pass
    name = f'ripgrep-{VERSION}-{triple}'
    url = f'https://github.com/BurntSushi/ripgrep/releases/download/{VERSION}/{name}.tar.gz'
    downloads = ROOT / 'runtime' / 'downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / f'{name}.tar.gz'
    if not archive.exists():
        partial = archive.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as output:
            shutil.copyfileobj(source, output)
        if sha256(partial) != archive_sha256:
            raise SystemExit(f'ripgrep archive checksum mismatch; preserved {partial}')
        partial.replace(archive)
    if sha256(archive) != archive_sha256:
        raise SystemExit(f'ripgrep archive checksum mismatch: {archive}')
    wanted = {f'{name}/rg', *(f'{name}/{license}' for license in LICENSES)}
    staging = Path(tempfile.mkdtemp(prefix='.ripgrep-build-', dir=ROOT / 'runtime'))
    try:
        staging.chmod(0o755)
        with tarfile.open(archive) as contents:
            members = [item for item in contents.getmembers() if item.name in wanted]
            if {item.name for item in members} != wanted or any(not item.isfile() for item in members):
                raise SystemExit('ripgrep archive does not have the expected files')
            for item in members:
                with contents.extractfile(item) as source, (staging / Path(item.name).name).open('wb') as output:
                    shutil.copyfileobj(source, output)
        (staging / 'bin').mkdir()
        binary = staging / 'bin' / 'rg'
        (staging / 'rg').replace(binary)
        binary.chmod(0o755)
        # The upstream binary carries a linker signature; keep its bytes when valid.
        if not signature_ok(binary):
            subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'rg', str(binary)], check=True)
        reported = subprocess.run([str(binary), '--version'], capture_output=True, text=True, check=True).stdout
        if not reported.startswith(f'ripgrep {VERSION}'):
            raise SystemExit(f'Unexpected ripgrep version: {reported.splitlines()[:1]}')
        manifest = {
            'recipe_version': RECIPE_VERSION, 'version': VERSION, 'target': triple, 'source_url': url,
            'archive_sha256': archive_sha256, 'binary_sha256': sha256(binary),
            'license': 'MIT OR Unlicense', 'license_files': list(LICENSES),
        }
        (staging / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        shutil.rmtree(destination, ignore_errors=True)
        staging.replace(destination)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    write_public_notice(destination, url)
    print(f'Ready: {final} ({reported.splitlines()[0]})')


if __name__ == '__main__':
    main()
