#!/usr/bin/env python3
"""Build a private macOS llama-server with matched GGML and embedded Metal.

Requires Python 3, CMake, and the Xcode Command Line Tools. No Homebrew links or
model files are changed. Only the pinned official source archive is downloaded.
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

RECIPE_VERSION = 2
COMMIT = '328874d054e0eb44591202a23c209cf02c18e3cb'
ARCHIVE_SHA256 = '25268feb0068129141758ba3323590fa9191d64412e85d049f027d989fbf9fd7'
URL = f'https://codeload.github.com/ggml-org/llama.cpp/tar.gz/{COMMIT}'
ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(args):
    subprocess.run([str(arg) for arg in args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=int, default=min(os.cpu_count() or 2, 6))
    parser.add_argument('--if-needed', action='store_true', help='Reuse a binary only when its manifest commit and SHA-256 match.')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        raise SystemExit('This runtime recipe targets macOS with Metal.')
    if args.jobs < 1:
        raise SystemExit('--jobs must be positive')
    destination = ROOT / 'runtime' / 'llama.cpp'
    final = destination / 'bin' / 'llama-server'
    manifest_path = destination / 'runtime-manifest.json'
    if args.if_needed and final.is_file() and manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
            if (manifest.get('recipe_version') == RECIPE_VERSION
                    and manifest.get('source_commit') == COMMIT
                    and manifest.get('archive_sha256') == ARCHIVE_SHA256
                    and '-DLLAMA_USE_PREBUILT_UI=OFF' in manifest.get('cmake_flags', [])
                    and manifest.get('binary_sha256') == sha256(final)):
                run(['codesign', '--verify', '--strict', final])
                print(f'Using verified private runtime: {final}')
                return
        except (OSError, ValueError, subprocess.CalledProcessError):
            pass
    for tool in ('cmake', 'clang', 'codesign', 'otool'):
        if not shutil.which(tool):
            raise SystemExit(f'Missing build prerequisite: {tool}')
    work = ROOT / 'runtime' / 'llama.cpp-build'
    work.mkdir(parents=True, exist_ok=True)
    archive = work / f'llama.cpp-{COMMIT}.tar.gz'
    if not archive.exists():
        partial = archive.with_suffix('.download')
        with urllib.request.urlopen(URL, timeout=120) as source, partial.open('wb') as output:
            shutil.copyfileobj(source, output)
        if sha256(partial) != ARCHIVE_SHA256:
            raise SystemExit(f'Source checksum mismatch; preserved {partial}')
        partial.replace(archive)
    if sha256(archive) != ARCHIVE_SHA256:
        raise SystemExit(f'Source checksum mismatch: {archive}')
    source = work / f'llama.cpp-{COMMIT}'
    if not source.exists():
        with tarfile.open(archive) as contents:
            for item in contents.getmembers():
                resolved = (work / item.name).resolve()
                if work.resolve() not in resolved.parents or item.issym() or item.islnk():
                    raise SystemExit(f'Unsafe archive member: {item.name}')
            contents.extractall(work)
    build = work / 'build-metal-static'
    # Upstream embeds stale cached UI assets even with both UI switches off.
    # Preserve any earlier download outside its search path before rebuilding.
    old_ui = build / 'tools' / 'ui' / 'dist'
    if old_ui.is_dir() and any(old_ui.iterdir()):
        preserved = Path(tempfile.mkdtemp(prefix='preserved-ui-assets-', dir=work))
        shutil.move(str(old_ui), str(preserved / 'dist'))
    flags = [
        '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
        '-DLLAMA_USE_SYSTEM_GGML=OFF', '-DGGML_BACKEND_DL=OFF',
        '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DGGML_OPENMP=OFF', '-DGGML_BLAS=ON', '-DGGML_BLAS_VENDOR=Apple',
        '-DLLAMA_OPENSSL=OFF', '-DLLAMA_BUILD_TESTS=OFF',
        '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_TOOLS=ON',
        '-DLLAMA_BUILD_SERVER=ON', '-DLLAMA_BUILD_APP=OFF', '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_USE_PREBUILT_UI=OFF',
        '-DLLAMA_BUILD_NUMBER=9330', f'-DLLAMA_BUILD_COMMIT={COMMIT[:9]}',
    ]
    run(['cmake', '-S', source, '-B', build, *flags])
    run(['cmake', '--build', build, '--config', 'Release', '--target', 'llama-server', '-j', str(args.jobs)])
    executable = build / 'bin' / 'llama-server'
    dependencies = subprocess.check_output(['otool', '-L', str(executable)], text=True)
    non_system = [line.strip() for line in dependencies.splitlines()[1:]
                  if not line.strip().startswith(('/usr/lib/', '/System/Library/'))]
    if non_system:
        raise SystemExit('Runtime is not self-contained: ' + '; '.join(non_system))
    (destination / 'bin').mkdir(parents=True, exist_ok=True)
    final = destination / 'bin' / 'llama-server'
    pending = final.with_name('llama-server.installing')
    shutil.copy2(executable, pending)
    pending.chmod(0o755)
    run(['codesign', '--force', '--sign', '-', '--identifier', 'llama-server', pending])
    pending.replace(final)
    for name in ('LICENSE',):
        shutil.copy2(source / name, destination / name)
    license_source = source / 'licenses'
    if license_source.exists():
        shutil.copytree(license_source, destination / 'licenses', dirs_exist_ok=True)
    # The upstream root LICENSE covers llama.cpp and its vendored GGML.
    for license_file in (source / 'vendor').rglob('LICENSE*'):
        if license_file.is_file():
            relative = license_file.relative_to(source / 'vendor')
            target = destination / 'licenses' / 'vendor' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(license_file, target)
    manifest = {
        'recipe_version': RECIPE_VERSION, 'source_url': URL, 'source_commit': COMMIT, 'archive_sha256': ARCHIVE_SHA256,
        'binary_sha256': sha256(final), 'cmake_flags': flags,
        'platform': platform.platform(), 'dependencies': dependencies.splitlines()[1:],
        'note': 'GGML is linked from the same source revision; Metal source is embedded. No Homebrew dylibs are required.',
    }
    pending_manifest = destination / 'runtime-manifest.json.installing'
    pending_manifest.write_text(json.dumps(manifest, indent=2) + '\n')
    pending_manifest.replace(destination / 'runtime-manifest.json')
    run([final, '--version'])
    print(f'Ready: {final}')


if __name__ == '__main__':
    main()
