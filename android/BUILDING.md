# Building the Dinoinsel Android app

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

`--offline` controls **build-tool downloads**, not the app's leaderboard
configuration. The app's network permission is derived only from the
explicit JSON block in the bundled game, as described below.

Outputs:

- `dino-insel/dist/Dinoinsel.apk` — signed, installable version 1.2.
- `dino-insel/dist/Dinoinsel.apk.sha256` — SHA-256 checksum.
- `dino-insel/dist/BUILD-INFO.json` — exact source/dependency/asset hashes,
  API configuration/mode, certificate fingerprint, binary manifest,
  package metadata, and verification results.
- `dino-insel/android/build/` — disposable native compilation intermediates.

Older `Dino-Insel.apk` artifacts are not deleted or overwritten by this
renamed release.

The build reads the actual `dino-insel/game/index.html` and packages its exact
bytes as `assets/index.html`. It never edits the game and never creates a
placeholder game. If the game is absent, incomplete, or missing its required
configuration block, the normal build fails without publishing an APK.
Native/toolchain compilation can still be checked independently:

```sh
./dino-insel/android/build.sh --check --offline
```

`--check` compiles the offline shell's resources, Java, DEX, and signing helper
without requiring a final game or creating a distributable. Publication
happens only after verification succeeds.
An unsuccessful build leaves any previously verified distribution untouched.
Do not mistake that older distribution for a successful new build.

## App identity and persistent shell

| Setting | Value |
| --- | --- |
| Package | `de.dinoinsel.game` |
| Launcher name | **Dinoinsel** |
| Version | **1.2 / version code 3** |
| Minimum Android | Android 8.0 / API 26 |
| Target / compile API | 35 / Android 15 |
| Native libraries | None; architecture-independent DEX |
| Android permissions | Empty configuration: none. Explicit API origin: **only** `android.permission.INTERNET`. |

`src/main/` uses the standard Android project layout. The original vector
dinosaur launcher icon is drawn entirely in XML; no third-party artwork is
included. The main UI is exclusively the bundled HTML.

The activity uses a persistent WebView profile and
`loadDataWithBaseURL("https://dino-insel.invalid/", ...)`. This reserved,
stable HTTPS origin is **not contacted**; it gives the inline document a
non-opaque origin for persistent `localStorage`. The entire HTML is read
from the application asset into memory rather than loaded with a `file:`
URL. JavaScript and DOM storage are enabled. File/content access, mixed
content, external navigation, geolocation, file selection, cookies, and
WebView debugging remain disabled in **both** modes. Service-worker network
loads are also disabled. There is no JavaScript bridge, local HTTP server,
tracker, advertising SDK, or runtime dependency download.

The shell requests sensor-controlled landscape and immersive fullscreen,
protects display-cutout margins, and lets the WebView resize with the window.
The native back callback on Android 13+ and the legacy back button both call
`window.dinoApp.handleBack()`. Only an explicit JavaScript `false` finishes
the activity; missing hooks or JavaScript errors do not accidentally exit.
Activity pause or loss of focus calls `window.dinoApp.pause()` to pause/save.
Activity resume resumes the WebView renderer, **not gameplay**.
The pause/back exception handlers retain their `console.error` diagnostics;
exceptions are not silently swallowed.

Saved games remain in this app's local storage across normal relaunches and
same-key upgrades. Clearing app data or uninstalling deletes them. Backups
are disabled. Neither the package nor `https://dino-insel.invalid/` changes
for this upgrade. The native shell never changes the game's localStorage
keys. The HTML remains responsible for its own game simulation, maths
pauses, save format, audio pause behavior, and player-controlled resume.

## Optional private friend leaderboard: explicit configuration only

The complete game must contain exactly one inline block:

```html
<script id="dino-config" type="application/json">{"leaderboardApiUrl":""}</script>
```

The empty string is the default **offline / unconfigured** state. It yields
zero Android permissions, `setBlockNetworkLoads(true)`, and a CSP that
forbids every network connection. No endpoint is guessed or auto-discovered.

Only after an actual endpoint is provided, set that value to its HTTPS
**origin**, for example `https://APP.azurewebsites.net`, then **rebuild and
install the new APK**. This is configuration documentation, not an endpoint
that this toolchain provisions or contacts. Do not set it merely to make an
unconfigured leaderboard appear enabled. A runtime setting, environment
variable, or `--offline` flag cannot enable networking in a previously
offline APK.

`runtime_config.py` rejects missing/duplicate blocks, duplicate JSON keys,
unknown fields, non-string values, HTTP, credentials, paths (including a
trailing slash), queries, fragments, whitespace, wildcard hosts, and invalid
ports/hostnames. ASCII DNS names/punycode and canonical IP literals are
supported. Scheme/host case and an explicit standard HTTPS port are
normalized. The original HTML bytes are still bundled unchanged.

The build derives `assets/runtime-config.json` from that block and generates
the manifest with exactly the expected permission set. A nonempty origin
adds only `android.permission.INTERNET`, a normal install-time Android
permission with no runtime consent dialog. No tokens, credentials or
private keys belong in the configuration block.

### Configured network boundary

The native WebView allows only non-navigation HTTPS requests to the exact
configured origin/port and `/api/` routes, using `GET`, `POST`, `DELETE`, or
`OPTIONS`. Other origins, paths, methods, ports, file/content URLs and
path-traversal variants are rejected. Navigation is always blocked,
including navigation to the otherwise permitted API.

Before loading the document, the native shell inserts a restrictive
Content Security Policy and its small `native-network.js` guard **in memory**.
The packaged game asset is not rewritten. The CSP hashes only the bundled
inline scripts and the guard; remote scripts, new untrusted inline scripts,
frames, workers, forms and external images/fonts/media are not permitted.
The game should use `addEventListener`, not inline event-handler attributes
or `eval`, and keep all its scripts inline.

Browser `fetch` is the sole API transport. Its locked wrapper keeps JSON
bodies and `Authorization: Bearer …` headers, enforces CORS, omits cookies,
and forces `redirect: "error"`. **All redirects fail**, including redirects
within the same API origin. This is deliberate: Android's
`shouldInterceptRequest` does not observe every redirect hop, and CSP path
restrictions alone do not cover redirect paths. XHR, WebSocket, EventSource,
beacon, WebTransport, WebRTC and worker alternatives are disabled so they
cannot bypass that redirect rule. No native JavaScript bridge is used.

The backend must handle the exact `/api/...` URLs without redirects and
answer CORS preflights for `GET, POST, DELETE, OPTIONS` and
`Authorization, Content-Type`. Allow the browser's serialized native origin
**`https://dino-insel.invalid`** (no trailing slash); any GitHub Pages origin
used by the separate web edition must be allowed by the backend separately.
The native build does not deploy, discover, probe, log in to, or otherwise
contact Azure or any configured API.

## Signing and reproducibility

An initial build creates a random-password, 3072-bit RSA **development**
key at the following paths; version 1.2 **reuses the existing key and alias**:

```text
.android-tools/signing/dino-insel-development.p12
.android-tools/signing/password.txt
```

That directory is outside the distributable `dino-insel/` source tree,
has mode `0700`, and its private files have mode `0600`. The whole tool-cache
directory is ignored by Git. Do **not** include `.android-tools/` in a source
archive or upload the signing files. Also exclude `android/build/`, which
contains disposable compilation output and deliberately configured test
fixtures, from distributable source archives. The APK contains only the public
certificate, never the private key or password. This is a locally generated
development identity, not a production or Play Store signing identity.

Keep the key and password together, backed up privately, if future builds
must update an installed copy without uninstalling. A freshly generated key
in another workspace produces a different certificate and cannot update
that existing installation. If an earlier APK exists but its signing key is
missing, the build refuses to generate an incompatible replacement. Before
publishing an upgrade it verifies that the certificate matches the existing
`Dinoinsel.apk`, or the legacy `Dino-Insel.apk` if that is the previous release.
The legacy key filename/alias and an existing certificate's subject are
intentionally not renamed.

For identical source, dependencies, signing key/certificate, Python/zlib,
and JDK, repeated builds are deterministic. Dependencies are pinned with
SHA-256 in `dependency-lock.json`; inputs are sorted; debug metadata is
omitted; ZIP timestamps default to 2026-01-01 UTC; RSA signing has no
per-build randomness. `SOURCE_DATE_EPOCH` can override ZIP timestamps
(the ZIP format clamps dates before 1980). Compare two complete builds:

```sh
./dino-insel/android/build.sh --offline
shasum -a 256 dino-insel/dist/Dinoinsel.apk
./dino-insel/android/build.sh --offline
shasum -a 256 dino-insel/dist/Dinoinsel.apk
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
3. DEX magic/version, file/header sizes, SHA-1 and Adler-32, and both the
   launcher and native network-policy classes.
4. The packaged **binary** manifest: package/version, label, launchable
   activity, min/target API, the **exact expected permission set** derived from
   the embedded configuration, and disabled backups, cleartext and debugging.
5. Google's apksig verification for both APK Signature Scheme **v2 and v3**
   across API 26–35. V1/JAR signing is unnecessary for this minimum API.
6. Every ZIP entry's CRC, supported compression, lack of encryption and
   duplicate entries, and required application contents.
7. Uncompressed `resources.arsc` and `classes.dex`, with **all** stored entries
   aligned to four bytes **after signing**. The standard `zipalign` result is
   achieved directly with valid ZIP extra fields, then independently checked.
   There are no ELF/native libraries requiring 16 KiB page alignment.
8. Byte-for-byte equality of the full source HTML, derived runtime-config
   asset and native network-guard asset. A concurrent change to the game
   during the build prevents publication.
9. The certificate matches the previous delivered APK when publishing an
   upgrade; the signing key and local save origin are preserved.

### Local native/network-policy checks

Run without a final game or any live API:

```sh
./dino-insel/android/build.sh --self-test --offline
```

In addition to normal build prerequisites, this check uses an existing
Node.js (18+) and Google Chrome on macOS. No npm modules or browser download
are needed. `DINO_CHROME` may point to an already installed Chrome executable.
It runs an isolated headless profile under `android/build/`, not the user's
browser profile, and removes the test browser profile on completion.

Coverage includes:

- Strict JSON/origin validation, both permission sets, version/name metadata,
  native and Gradle manifest agreement, signature checks and ZIP alignment.
- Signed blank/offline and explicitly configured **test-only** APKs using
  `https://dinoinsel-test.azurewebsites.net`; they are written only under
  `android/build/policy-checks/`, never `dist/`.
- Verification rejects mismatched HTML, a validly signed incorrect runtime
  config, and unsigned/tampered fixtures.
- 73 pure-Java policy checks covering exact origin/port/path/method matching,
  offline denial, traversal/credential rejection, navigation denial and CSP.
- Real Chrome fetch/CSP/CORS behavior with all page requests fulfilled from
  in-memory fixtures over a local debugging pipe: bearer/JSON
  `GET/POST/DELETE/OPTIONS`, blocked origins/paths/transports, cookies omitted,
  retained localStorage origin, and denial of **all three redirect classes**
  (unrelated origin, non-API path, same-API destination).
- Existing APKs and the original signing-key file remain unchanged.

Chrome's test process has background networking disabled and hostname
resolution restricted to loopback as a second guard. No request reaches
the test domain, Azure or another live API. Results are recorded in
`android/build/POLICY-CHECKS.json`. These fixtures never configure the real
game and no distribution APK is published by `--self-test`.

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
The Gradle pre-build task invokes the same strict Python configuration parser
to snapshot the HTML, runtime-config and network-guard assets and to generate
the same conditional permission set. It removes the legacy manifest
`package` attribute that standalone AAPT2 requires, leaving shared source
unchanged; modern AGP gets the namespace from Gradle.

To keep Gradle's cache in this workspace:

```sh
GRADLE_USER_HOME="$PWD/.android-tools/gradle" \
  gradle -p dino-insel/android --no-daemon assembleRelease
```

The optional Gradle release is unsigned; use `build.sh` for the signed
`dist/Dinoinsel.apk`. Gradle's optional debug signing key is also configured
under `.android-tools/signing/`, rather than the global `~/.android/` directory.
