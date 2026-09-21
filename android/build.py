#!/usr/bin/env python3
"""Build the native shell using pinned, workspace-local, open-source Android tools."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import struct
import subprocess
import sys
import time
import zipfile
import zlib


ANDROID = Path(__file__).resolve().parent
WORKSPACE = ANDROID.parent.parent
TOOLS = WORKSPACE / ".android-tools"
BUILD = ANDROID / "build"
DIST = ANDROID.parent / "dist"
GAME = ANDROID.parent / "game" / "index.html"
APK = DIST / "Dino-Insel.apk"
LOCK = json.loads((ANDROID / "dependency-lock.json").read_text(encoding="utf-8"))
DEFAULT_EPOCH = 1767225600


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_directory(path):
    require(path.resolve().is_relative_to(WORKSPACE),
            "Output directory must remain inside this workspace: " + str(path))
    path.mkdir(parents=True, exist_ok=True)
    return path


def run(command, capture=False):
    result = subprocess.run(
        [str(value) for value in command],
        cwd=WORKSPACE,
        env=os.environ.copy(),
        check=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        text=True,
    )
    return result.stdout.strip() if capture else ""


def find_java():
    candidates = []
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]))
    candidates += [
        Path.home() / "Library/Java/JavaVirtualMachines/ms-17.0.15/Contents/Home",
        Path("/Library/Java/JavaVirtualMachines/microsoft-21.jdk/Contents/Home"),
    ]
    javac = shutil.which("javac")
    if javac:
        candidates.append(Path(javac).resolve().parent.parent)
    for candidate in candidates:
        java = candidate / "bin" / "java"
        if not java.is_file() or not (candidate / "bin" / "javac").is_file():
            continue
        version = run([java, "-version"], capture=True)
        match = re.search(r'version "(\d+)', version)
        if match and int(match.group(1)) in (17, 21):
            return candidate, version.splitlines()[0]
    raise RuntimeError("A JDK 17 or 21 is required. Set JAVA_HOME to an existing JDK; "
                       "this script does not install one or change the system JDK.")


def dependencies(offline):
    require(platform.system() == "Darwin",
            "The locked AAPT2 binary is for macOS (arm64 and x86_64).")
    downloads = safe_directory(TOOLS / "downloads")
    paths = {}
    for name, entry in LOCK.items():
        destination = downloads / entry["filename"]
        if not destination.is_file():
            require(not offline, "Offline build needs cached dependency: " + str(destination))
            print("Downloading " + entry["filename"], flush=True)
            partial = destination.with_suffix(destination.suffix + ".partial")
            try:
                run(["curl", "--fail", "--location", "--silent", "--show-error",
                     "--retry", "2", "--connect-timeout", "20", "--max-time", "600",
                     entry["url"], "--output", partial])
                require(sha256(partial) == entry["sha256"],
                        "Downloaded dependency failed SHA-256 verification: " + entry["filename"])
                partial.replace(destination)
            finally:
                partial.unlink(missing_ok=True)
        require(sha256(destination) == entry["sha256"],
                "Cached dependency failed SHA-256 verification: " + str(destination))
        paths[name] = destination
    binary_dir = safe_directory(TOOLS / ("aapt2-" + LOCK["aapt2"]["version"]))
    notices = safe_directory(TOOLS / "licenses")
    with zipfile.ZipFile(paths["aapt2"]) as archive:
        binary = archive.read("aapt2")
        aapt2 = binary_dir / "aapt2"
        if not aapt2.is_file() or aapt2.read_bytes() != binary:
            aapt2.write_bytes(binary)
        aapt2.chmod(0o755)
        (notices / "aapt2-NOTICE.txt").write_bytes(archive.read("NOTICE"))
    for name in ("r8", "apksig"):
        with zipfile.ZipFile(paths[name]) as archive:
            (notices / (name + "-LICENSE.txt")).write_bytes(archive.read("LICENSE"))
    paths["aapt2_bin"] = aapt2
    return paths


def java_command(java_home):
    return [java_home / "bin" / "java", "-Djava.io.tmpdir=" + str(TOOLS / "work"),
            "-Duser.language=en", "-Duser.country=US", "-Duser.timezone=UTC"]


def compile_signer(java_home, paths):
    destination = safe_directory(BUILD / "apktool")
    run([java_home / "bin" / "javac", "-J-Djava.io.tmpdir=" + str(TOOLS / "work"),
         "--release", "17", "-encoding", "UTF-8",
         "-g:none", "-cp", paths["apksig"], "-d", destination,
         ANDROID / "tools" / "ApkTool.java"])


def signer_command(java_home, paths):
    return java_command(java_home) + [
        "-cp", str(BUILD / "apktool") + os.pathsep + str(paths["apksig"]), "ApkTool"]


def compile_native(java_home, paths):
    require(not BUILD.is_symlink(), "Refusing to replace a symlinked build directory.")
    if BUILD.exists():
        shutil.rmtree(BUILD)
    safe_directory(BUILD)
    generated = safe_directory(BUILD / "generated")
    classes = safe_directory(BUILD / "classes")
    dex = safe_directory(BUILD / "dex")
    print("Compiling resources and Android shell…", flush=True)
    run([paths["aapt2_bin"], "compile", "--dir", ANDROID / "src/main/res",
         "-o", BUILD / "resources.zip"])
    run([paths["aapt2_bin"], "link", "-I", paths["framework"],
         "--manifest", ANDROID / "src/main/AndroidManifest.xml",
         "--java", generated, "--min-sdk-version", "26", "--target-sdk-version", "35",
         "--version-code", "1", "--version-name", "1.0",
         "-o", BUILD / "resources.apk", BUILD / "resources.zip"])
    sources = sorted((ANDROID / "src/main/java").rglob("*.java"))
    sources += sorted(generated.rglob("*.java"))
    run([java_home / "bin" / "javac", "-J-Djava.io.tmpdir=" + str(TOOLS / "work"),
         "--release", "8", "-encoding", "UTF-8",
         "-g:none", "-cp", paths["framework"], "-d", classes] + sources)
    run(java_command(java_home) + ["-cp", paths["r8"], "com.android.tools.r8.D8",
        "--release", "--min-api", "26", "--lib", paths["framework"], "--output", dex]
        + sorted(classes.rglob("*.class")))
    verify_dex((dex / "classes.dex").read_bytes())
    compile_signer(java_home, paths)


def verify_dex(data):
    require(len(data) >= 112 and data[:4] == b"dex\n" and data[7] == 0,
            "DEX header is missing or invalid.")
    require(data[4:7] in (b"035", b"037", b"038"),
            "DEX version is not supported by the minimum Android version.")
    require(struct.unpack_from("<I", data, 32)[0] == len(data), "DEX size mismatch.")
    require(struct.unpack_from("<I", data, 36)[0] == 112, "Unexpected DEX header size.")
    require(struct.unpack_from("<I", data, 40)[0] == 0x12345678,
            "Unexpected DEX endianness.")
    require(hashlib.sha1(data[32:]).digest() == data[12:32], "DEX SHA-1 mismatch.")
    require(zlib.adler32(data[12:]) & 0xffffffff == struct.unpack_from("<I", data, 8)[0],
            "DEX Adler-32 mismatch.")
    require(b"Lde/dinoinsel/game/MainActivity;" in data, "MainActivity is absent from DEX.")


def game_bytes():
    require(GAME.is_file(), "The full game is not ready: " + str(GAME)
            + "\nNo placeholder APK was created. Run --check to validate the shell alone.")
    data = GAME.read_bytes()
    text = data.decode("utf-8")
    require(len(data) >= 4096 and re.search(r"<canvas\b", text, re.I)
            and re.search(r"</html\s*>", text, re.I)
            and all(hook in text for hook in ("dinoApp", "handleBack", "pause")),
            "The game asset must be the complete HTML canvas game with dinoApp lifecycle hooks.")
    return data


def assemble(game):
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", str(DEFAULT_EPOCH)))
    timestamp = time.gmtime(max(epoch, 315532800))[:6]
    require(timestamp[0] <= 2107, "SOURCE_DATE_EPOCH exceeds the ZIP format's date range.")
    timestamp = timestamp[:5] + (timestamp[5] // 2 * 2,)
    with zipfile.ZipFile(BUILD / "resources.apk") as resources:
        entries = {item.filename: resources.read(item) for item in resources.infolist()
                   if not item.is_dir()}
    entries["classes.dex"] = (BUILD / "dex/classes.dex").read_bytes()
    entries["assets/index.html"] = game
    target = BUILD / "unsigned.apk"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9, allowZip64=False) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, timestamp)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = (zipfile.ZIP_STORED
                                  if name in ("classes.dex", "resources.arsc")
                                  else zipfile.ZIP_DEFLATED)
            if info.compress_type == zipfile.ZIP_STORED:
                # A valid private ZIP extra field aligns stored entry data to four bytes.
                offset = archive.fp.tell() + 30 + len(name.encode("utf-8")) + 4
                padding = -offset % 4
                info.extra = struct.pack("<HH", 0xffff, padding) + b"\0" * padding
            archive.writestr(info, entries[name], compresslevel=9)
    return target


def development_key(java_home):
    directory = safe_directory(TOOLS / "signing")
    directory.chmod(0o700)
    keystore = directory / "dino-insel-development.p12"
    password = directory / "password.txt"
    require(not keystore.exists() or password.is_file(),
            "The development keystore exists but its password file is missing. "
            "Restore the password; a replacement key cannot update existing installations.")
    if not keystore.exists():
        print("Creating a workspace-local development key (not included in source or APK)…",
              flush=True)
        if not password.exists():
            descriptor = os.open(password, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(secrets.token_urlsafe(40) + "\n")
        run([java_home / "bin" / "keytool", "-J-Djava.io.tmpdir=" + str(TOOLS / "work"),
             "-genkeypair", "-noprompt",
             "-keystore", keystore, "-storetype", "PKCS12",
             "-storepass:file", password, "-keypass:file", password,
             "-alias", "dino-insel-development", "-keyalg", "RSA", "-keysize", "3072",
             "-validity", "10000", "-dname", "CN=Dino Insel Development, O=Dino Insel, C=DE"])
    keystore.chmod(0o600)
    password.chmod(0o600)
    return keystore, password


def verify_apk(path, game, java_home, paths):
    require(path.is_file(), "APK not found: " + str(path))
    signature = json.loads(run(signer_command(java_home, paths) + ["verify", path], capture=True))
    badging = run([paths["aapt2_bin"], "dump", "badging", path], capture=True)
    manifest = run([paths["aapt2_bin"], "dump", "xmltree",
                    "--file", "AndroidManifest.xml", path], capture=True)
    require("package: name='de.dinoinsel.game' versionCode='1' versionName='1.0'" in badging,
            "APK package name or version is incorrect.")
    require(re.search(r"(?:minSdkVersion|sdkVersion):'26'", badging)
            and "targetSdkVersion:'35'" in badging,
            "APK must target API 35 with minimum API 26.")
    require("application-label:'Dino Insel'" in badging, "APK application label is incorrect.")
    require("launchable-activity: name='de.dinoinsel.game.MainActivity'" in badging,
            "APK launcher activity is missing.")
    require(not re.search(r"uses-permission", badging + manifest), "APK declares permissions.")
    require("application-debuggable" not in badging, "APK must not be debuggable.")
    for attribute in ("allowBackup", "usesCleartextTraffic", "debuggable"):
        require(re.search(r"android:" + attribute + r"\([^)]*\)=false", manifest),
                "APK must set android:" + attribute + "=false.")
    stored = []
    with zipfile.ZipFile(path) as archive, path.open("rb") as raw:
        require(archive.testzip() is None, "APK ZIP CRC validation failed.")
        names = archive.namelist()
        require(len(names) == len(set(names)), "APK contains duplicate ZIP entries.")
        require({"AndroidManifest.xml", "resources.arsc", "classes.dex", "assets/index.html"}
                .issubset(names), "Required APK contents are missing.")
        require(all(name in ("AndroidManifest.xml", "resources.arsc", "classes.dex",
                             "assets/index.html") or name.startswith("res/") for name in names),
                "APK contains unexpected files or bundled build dependencies.")
        require(archive.read("assets/index.html") == game,
                "The packaged HTML differs from the current complete game.")
        verify_dex(archive.read("classes.dex"))
        for info in archive.infolist():
            require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    "An APK entry uses an unsupported compression method.")
            require(not info.flag_bits & 1, "Encrypted ZIP entries are not allowed.")
            raw.seek(info.header_offset)
            header = raw.read(30)
            require(header[:4] == b"PK\x03\x04", "ZIP local header is invalid.")
            filename_length, extra_length = struct.unpack_from("<HH", header, 26)
            data_offset = info.header_offset + 30 + filename_length + extra_length
            if info.compress_type == zipfile.ZIP_STORED:
                require(data_offset % 4 == 0, "Unaligned stored APK entry: " + info.filename)
                stored.append(info.filename)
        require({"resources.arsc", "classes.dex"}.issubset(stored),
                "Resource table and DEX must be stored, not compressed.")
    return {
        "package": "de.dinoinsel.game",
        "versionName": "1.0",
        "versionCode": 1,
        "minSdk": 26,
        "targetSdk": 35,
        "permissions": [],
        "signature": signature,
        "storedEntriesAlignedTo4Bytes": stored,
        "nativeLibraries": [],
        "assetBytes": len(game),
        "assetSha256": hashlib.sha256(game).hexdigest(),
        "apkSha256": sha256(path),
        "apkBytes": path.stat().st_size,
        "badging": badging,
        "binaryManifest": manifest,
    }


def publish(signed, report, java_version):
    safe_directory(DIST)
    staging = DIST / "Dino-Insel.apk.next"
    shutil.copyfile(signed, staging)
    staging.chmod(0o644)
    staging.replace(APK)
    (DIST / "Dino-Insel.apk.sha256").write_text(
        report["apkSha256"] + "  Dino-Insel.apk\n", encoding="utf-8")
    sources = sorted(path for path in (ANDROID / "src/main").rglob("*") if path.is_file())
    sources += [ANDROID / "build.py", ANDROID / "build.sh",
                ANDROID / "tools/ApkTool.java", ANDROID / "dependency-lock.json"]
    report["sourceSha256"] = {
        path.relative_to(ANDROID).as_posix(): sha256(path) for path in sources}
    report["buildJava"] = java_version
    report["dependencies"] = LOCK
    report["zipEpoch"] = int(os.environ.get("SOURCE_DATE_EPOCH", str(DEFAULT_EPOCH)))
    report["signingNote"] = "Workspace-local development key; not a production/Play Store key."
    report["runtimeTesting"] = "No emulator or physical Android device was used."
    (DIST / "BUILD-INFO.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="Compile native code/resources/DEX only; do not produce a game APK.")
    mode.add_argument("--verify", action="store_true",
                      help="Verify the existing final APK against the current game source.")
    parser.add_argument("--offline", action="store_true",
                        help="Require cached dependencies; never download.")
    args = parser.parse_args()
    require(sys.version_info >= (3, 9), "Python 3.9 or later is required.")
    safe_directory(TOOLS / "work")
    os.environ["TMPDIR"] = str(TOOLS / "work")
    os.environ["TMP"] = str(TOOLS / "work")
    os.environ["TEMP"] = str(TOOLS / "work")
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    java_home, java_version = find_java()
    print("Using " + java_version, flush=True)
    paths = dependencies(args.offline)
    print(run([paths["aapt2_bin"], "version"], capture=True), flush=True)
    if args.verify:
        compile_signer(java_home, paths)
        report = verify_apk(APK, game_bytes(), java_home, paths)
        print("Verified APK: v2 + v3, API 26–35, no permissions, aligned ZIP, exact game asset.")
        print("SHA-256: " + report["apkSha256"])
        return
    game = None if args.check else game_bytes()
    compile_native(java_home, paths)
    if args.check:
        print("Native resources, Java, DEX and signer compile successfully.")
        print("No distributable APK created (--check mode).")
        return
    unsigned = assemble(game)
    keystore, password = development_key(java_home)
    signed = BUILD / "signed.apk"
    run(signer_command(java_home, paths)
        + ["sign", unsigned, signed, keystore, password])
    report = verify_apk(signed, game, java_home, paths)
    require(GAME.read_bytes() == game, "Game changed during the build; rerun to package its latest version.")
    publish(signed, report, java_version)
    print("Verified APK: v2 + v3, API 26–35, no permissions, aligned ZIP, exact game asset.")
    print("Created " + str(APK.relative_to(WORKSPACE)))
    print("SHA-256: " + report["apkSha256"])


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        if error.stdout:
            print(error.stdout, file=sys.stderr)
        print("Build command failed: " + str(error), file=sys.stderr)
        sys.exit(1)
    except (RuntimeError, ValueError, OSError, zipfile.BadZipFile) as error:
        print("Build failed: " + str(error), file=sys.stderr)
        sys.exit(1)
