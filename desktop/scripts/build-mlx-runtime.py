#!/usr/bin/env python3
"""Build G-Code's own MLX inference server (desktop/mlx-server) into desktop/runtime/mlx.

Needs Xcode and its Metal Toolchain (xcodebuild -downloadComponent MetalToolchain): SwiftPM alone
cannot compile MLX's Metal shaders.
"""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

RECIPE_VERSION = 1
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'mlx-server'
DESTINATION = ROOT / 'runtime' / 'mlx'
BUILD = SOURCE / 'build' / 'dd'
PRODUCTS = BUILD / 'Build' / 'Products' / 'Release'
BINARY = 'gcode-mlx-server'
# Resources the program finds beside itself; the metallib in the Cmlx bundle is MLX's GPU code.
BUNDLES = ('mlx-swift_Cmlx.bundle', 'swift-transformers_Hub.bundle', 'swift-crypto_Crypto.bundle')
INPUTS = ('Package.swift', 'Package.resolved', 'Sources', 'Vendor')


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def source_sha256():
    digest = hashlib.sha256(str(RECIPE_VERSION).encode())
    for name in INPUTS:
        path = SOURCE / name
        files = [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file() and p.name != '.DS_Store')
        for item in files:
            digest.update(str(item.relative_to(SOURCE)).encode() + b'\0' + file_sha256(item).encode())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--if-needed', action='store_true', help='Reuse the built server when its sources have not changed.')
    args = parser.parse_args()
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        print('MLX needs Apple Silicon; skipping the MLX runtime.')
        return
    expected = source_sha256()
    manifest_path = DESTINATION / 'runtime-manifest.json'
    final = DESTINATION / 'bin' / BINARY
    if args.if_needed and final.is_file() and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('source_sha256') == expected and manifest.get('binary_sha256') == file_sha256(final):
            print(f'MLX runtime is current: {final}')
            return

    subprocess.check_call(['xcodebuild', '-scheme', BINARY, '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64',
                           '-derivedDataPath', str(BUILD), '-skipPackagePluginValidation', '-skipMacroValidation', '-quiet', 'build'], cwd=SOURCE)

    pending = DESTINATION.with_name('mlx.installing')
    shutil.rmtree(pending, ignore_errors=True)
    (pending / 'bin').mkdir(parents=True)
    shutil.copy2(PRODUCTS / BINARY, pending / 'bin' / BINARY)
    for bundle in BUNDLES:
        shutil.copytree(PRODUCTS / bundle, pending / 'bin' / bundle)
    licenses = pending / 'licenses'
    licenses.mkdir()
    for package, directory in (('mlx-swift', SOURCE / 'Vendor' / 'mlx-swift'), ('mlx-swift-lm', SOURCE / 'Vendor' / 'mlx-swift-lm')):
        (licenses / package).mkdir()
        for name in ('LICENSE', 'ACKNOWLEDGMENTS.md', 'VENDORED-FROM.txt'):
            if (directory / name).is_file():
                shutil.copy2(directory / name, licenses / package / name)
    for checkout in sorted((BUILD / 'SourcePackages' / 'checkouts').iterdir()):
        found = [p for p in checkout.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE', 'NOTICE'))]
        if found:
            (licenses / checkout.name).mkdir()
            for path in found:
                shutil.copy2(path, licenses / checkout.name / path.name)

    # Package checkouts are read-only; the app bundler has to be able to replace its copies.
    for item in pending.rglob('*'):
        item.chmod(item.stat().st_mode | 0o200)

    binary_sha = file_sha256(pending / 'bin' / BINARY)
    (pending / 'runtime-manifest.json').write_text(json.dumps({'recipe_version': RECIPE_VERSION, 'source_sha256': expected, 'binary_sha256': binary_sha}, indent=2) + '\n')
    shutil.rmtree(DESTINATION, ignore_errors=True)
    pending.replace(DESTINATION)
    print(f'Built MLX runtime: {final}')


if __name__ == '__main__':
    main()
