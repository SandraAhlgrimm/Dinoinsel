# Building the Dino Insel Android app

## Verified, SDK-free build on macOS

Run from the workspace directory that contains `dino-insel/`:

```sh
./dino-insel/android/build.sh
```

Or run `./build.sh` from this directory. Prerequisites: macOS arm64 or
x86_64, Python 3.9+, `curl`, and an existing JDK 17 or 21. No npm dependencies,
Android Studio, Android SDK, Gradle, Rosetta, `adb`, or global installations
are needed. The first run downloads approximately 200 MiB of **build-only**
dependencies into the workspace's `.android-tools/`. Subsequent runs reuse
the checksum-verified cache.

The script first considers a compatible `JAVA_HOME`, then the existing
Microsoft JDK 17/21 macOS locations, then the JDK on `PATH`. An incompatible
JDK 25 on `PATH` is not used. To select a specific installed JDK:

```sh
JAVA_HOME="/path/to/jdk-17/Contents/Home" ./dino-insel/android/build.sh
```

After the first build, the complete build can run without network access:

```sh
./dino-insel/android/build.sh --offline
./dino-insel/android/build.sh --verify --offline
```

Outputs:

- `dino-insel/dist/Dino-Insel.apk` — signed, installable application.
- `dino-insel/dist/Dino-Insel.apk.sha256` — SHA-256 checksum.
- `dino-insel/dist/BUILD-INFO.json` — exact source/dependency/asset hashes,
  certificate fingerprint, binary manifest, package metadata, and verification results.
- `dino-insel/android/build/` — disposable native compilation intermediates.

The build reads the actual `dino-insel/game/index.html` and packages its exact
bytes as `assets/index.html`. It never edits the game and never creates a
placeholder game. If the game is absent or incomplete, the normal build fails
without publishing an APK. Native/toolchain compilation can still be checked:

```sh
./dino-insel/android/build.sh --check --offline
```

`--check` compiles resources, Java, DEX, and the signing helper but does not
create a distributable. Publication happens only after verification succeeds.
An unsuccessful build leaves any previously verified distribution untouched.
Do not mistake that older distribution for a successful new build.

## App identity and offline shell

| Setting | Value |
| --- | --- |
| Package | `de.dinoinsel.game` |
| Launcher name | Dino Insel |
| Version | 1.0 / version code 1 |
| Minimum Android | Android 8.0 / API 26 |
| Target / compile API | 35 / Android 15 |
| Native libraries | None; architecture-independent DEX |
| Android permissions | None, including no `INTERNET` permission |

`src/main/` uses the standard Android project layout. The original vector
dinosaur launcher icon is drawn entirely in XML; no third-party artwork is
included. The main UI is exclusively the bundled HTML.

The activity uses a persistent WebView profile and
`loadDataWithBaseURL("https://dino-insel.invalid/", ...)`. This reserved,
stable HTTPS origin is **not contacted**; it gives the inline document a
non-opaque origin for persistent `localStorage`. The entire HTML is read
from the application asset into memory rather than loaded with a `file:`
URL. JavaScript and DOM storage are enabled, but network loads, file/content
access, mixed content, external navigation, geolocation, file selection, and
WebView debugging are disabled. There is no JavaScript bridge, local HTTP
server, tracker, advertising SDK, or runtime dependency download.

The shell requests sensor-controlled landscape and immersive fullscreen,
protects display-cutout margins, and lets the WebView resize with the window.
The native back callback on Android 13+ and the legacy back button both call
`window.dinoApp.handleBack()`. Only an explicit JavaScript `false` finishes
the activity; missing hooks or JavaScript errors do not accidentally exit.
Activity pause or loss of focus calls `window.dinoApp.pause()` to pause/save.
Activity resume resumes the WebView renderer, **not gameplay**.

Saved games remain in this app's local storage across normal relaunches and
same-key upgrades. Clearing app data or uninstalling deletes them. Backups
are disabled. The HTML remains responsible for its own game simulation,
save format, audio pause behavior, and explicit player-controlled resume.

## Signing and reproducibility

The first real build creates a random-password, 3072-bit RSA **development**
key at:

```text
.android-tools/signing/dino-insel-development.p12
.android-tools/signing/password.txt
```

That directory is outside the distributable `dino-insel/` source tree,
has mode `0700`, and its private files have mode `0600`. The whole tool-cache
directory is ignored by Git. Do **not** include `.android-tools/` in a source
archive or upload the signing files. The APK contains only the public
certificate, never the private key or password. This is a locally generated
development identity, not a production or Play Store signing identity.

Keep the key and password together, backed up privately, if future builds
must update an installed copy without uninstalling. A freshly generated key
in another workspace produces a different certificate and cannot update
that existing installation.

For identical source, dependencies, signing key/certificate, Python/zlib,
and JDK, repeated builds are deterministic. Dependencies are pinned with
SHA-256 in `dependency-lock.json`; inputs are sorted; debug metadata is
omitted; ZIP timestamps default to 2026-01-01 UTC; RSA signing has no
per-build randomness. `SOURCE_DATE_EPOCH` can override ZIP timestamps
(the ZIP format clamps dates before 1980). Compare two complete builds:

```sh
./dino-insel/android/build.sh --offline
shasum -a 256 dino-insel/dist/Dino-Insel.apk
./dino-insel/android/build.sh --offline
shasum -a 256 dino-insel/dist/Dino-Insel.apk
```

The build does not invoke or silently accept Android SDK license terms.
It does not install software on a device, start an emulator, change OS
settings, upload files, or modify any other repository. All writable tool
and scratch paths stay within the workspace.

## Dependency and license provenance

Exact artifact URLs, versions, SHA-256 digests, and upstream POM URLs are in
`dependency-lock.json`.

| Component | Source and version | Declared license / notices |
| --- | --- | --- |
| AAPT2 | Google Maven, `com.android.tools.build:aapt2:9.4.1-15978811`, `osx` classifier; universal arm64/x86_64 executable | Apache-2.0; bundled `NOTICE` |
| D8 / R8 | Google Maven, `com.android.tools:r8:8.9.35` | R8 is BSD-3-Clause; the bundled `LICENSE` lists its dependency licenses |
| apksig | Google Maven, `com.android.tools.build:apksig:8.9.1` | Apache-2.0; bundled `LICENSE` |
| Android 15 compile framework/resources | Maven Central, `org.robolectric:android-all:15-robolectric-12650502`, built from AOSP | Apache-2.0 as declared by its POM, not a proprietary Android SDK platform download |

Build-tool notices are extracted into `.android-tools/licenses/`. The
framework POM explicitly distinguishes the source-built Apache-licensed
artifact from SDK binaries with a separate SDK EULA. These artifacts are
used only on the build machine; **none of their JARs or native build tools
are bundled in the APK**. Android's system WebView is supplied by the
tablet's existing operating system.

## What is verified

Every normal build, and every `--verify`, checks:

1. All cached/downloaded build dependencies against their pinned SHA-256.
2. AAPT2 compilation/linking and real `javac` + D8 compilation (normal build).
3. DEX magic/version, file/header sizes, SHA-1 and Adler-32, and the launcher class.
4. The packaged **binary** manifest: package/version, label, launchable
   activity, min/target API, no permissions, disabled backups, cleartext and
   debugging.
5. Google's apksig verification for both APK Signature Scheme **v2 and v3**
   across API 26–35. V1/JAR signing is unnecessary for this minimum API.
6. Every ZIP entry's CRC, supported compression, lack of encryption and
   duplicate entries, and required application contents.
7. Uncompressed `resources.arsc` and `classes.dex`, with **all** stored entries
   aligned to four bytes **after signing**. The standard `zipalign` result is
   achieved directly with valid ZIP extra fields, then independently checked.
   There are no ELF/native libraries requiring 16 KiB page alignment.
8. Byte-for-byte equality between the full source HTML and packaged asset.
   A concurrent change to the game during the build prevents publication.

**Runtime boundary:** no physical device or emulator is used by this
toolchain, so compilation/package/signature checks are not a substitute for
an Android smoke test. On a test tablet, check fresh launch in airplane
mode, touch controls, rotation/resize, audio, Home/lock/unlock returning to
pause, Back from play/pause/home, and save persistence after a relaunch.
Installation is deliberately left to the owner of the tablet.

## Optional conventional Gradle project

`settings.gradle.kts`, `build.gradle.kts`, and `gradle.properties` are included
for existing Android development environments. They are **not** the verified
SDK-free build path above and were not executed in this workspace, which
has neither Gradle nor an Android SDK. Use an already installed compatible
Gradle (8.11.1 for AGP 8.9.1), JDK 17, and an SDK/API 35 whose licenses you
have personally reviewed and accepted. Automatic SDK downloads are disabled.
No Gradle wrapper or SDK installer is bundled.
The Gradle pre-build task derives a manifest without the legacy `package`
attribute that standalone AAPT2 requires, leaving the shared source manifest
unchanged; modern AGP gets the namespace from the Gradle configuration.

To keep Gradle's cache in this workspace:

```sh
GRADLE_USER_HOME="$PWD/.android-tools/gradle" \
  gradle -p dino-insel/android --no-daemon assembleRelease
```

The optional Gradle release is unsigned; use `build.sh` for the signed
`dist/Dino-Insel.apk`. Gradle's optional debug signing key is also configured
under `.android-tools/signing/`, rather than the global `~/.android/` directory.
