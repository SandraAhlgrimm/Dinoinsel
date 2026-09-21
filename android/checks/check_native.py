"""Local-only checks; fixture APKs live under android/build, never dist."""

import json
import shutil
import subprocess
import unittest
import xml.etree.ElementTree as ET
import zipfile

from runtime_config import (
    ANDROID_NAMESPACE, CONFIG_ASSET, CONFIG_KEY, INTERNET_PERMISSION, canonical_origin,
    config_bytes, expected_permissions, offline_config, parse_game_config, write_manifest,
)


FAKE_API = "https://dinoinsel-test.azurewebsites.net"


def fixture_game(value):
    config = json.dumps({CONFIG_KEY: value}, separators=(",", ":"))
    return ("<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\">"
            "<title>Dinoinsel – native test fixture, not a game distribution</title>"
            "<script>window.fixtureLoaded = true;</script></head><body><canvas></canvas>"
            "<script id=\"dino-config\" type=\"application/json\">" + config + "</script>"
            "<script>window.dinoApp={pause:function(){window.fixturePaused=true;},"
            "handleBack:function(){return false;}};</script>"
            "</body></html>").encode("utf-8")


class ConfigurationChecks(unittest.TestCase):
    def test_explicit_empty_config(self):
        self.assertEqual(parse_game_config(fixture_game("")), offline_config())
        self.assertEqual(expected_permissions(offline_config()), [])
        self.assertEqual(config_bytes(offline_config()), b'{"leaderboardApiUrl":""}\n')

    def test_configured_origin(self):
        config = parse_game_config(fixture_game(FAKE_API))
        self.assertEqual(config[CONFIG_KEY], FAKE_API)
        self.assertEqual(expected_permissions(config), [INTERNET_PERMISSION])

    def test_canonicalization(self):
        for value, expected in (
                ("HTTPS://APP.AzureWebsites.NET:443", "https://app.azurewebsites.net"),
                ("https://app.azurewebsites.net:8443", "https://app.azurewebsites.net:8443"),
                ("https://[2001:0db8:0:0:0:0:0:1]:8443", "https://[2001:db8::1]:8443"),
                ("https://192.0.2.5", "https://192.0.2.5"),
                ("https://xn--bcher-kva.example", "https://xn--bcher-kva.example")):
            with self.subTest(value=value):
                self.assertEqual(canonical_origin(value), expected)

    def test_invalid_origin_values(self):
        for value in (
                None, False, 42, [], {}, " ", "http://app.azurewebsites.net",
                "https://app.azurewebsites.net/", "https://app.azurewebsites.net/api",
                "https://app.azurewebsites.net?query=1", "https://app.azurewebsites.net#x",
                "https://user@app.azurewebsites.net", "https://user:pass@app.azurewebsites.net",
                "https://app.azurewebsites.net:", "https://app.azurewebsites.net:0",
                "https://app.azurewebsites.net:65536", "https://*.azurewebsites.net",
                "//app.azurewebsites.net", "https://app.azurewebsites.net\\@evil.invalid",
                "https://app.azurewebsites.net\n", "https://app.azurewebsites.net\t",
                "https://a..example", "https://-a.example", "https://a-.example",
                "https://app.azurewebsites.net.", "https://%61pp.azurewebsites.net",
                "https://127.1", "https://0177.0.0.1", "https://0x7f000001",
                "https://[::1%25en0]", "https://bücher.example",
                "data:application/json,{}", "file:///api", "javascript:alert(1)"):
            with self.subTest(value=value):
                with self.assertRaises((ValueError, TypeError)):
                    canonical_origin(value)

    def test_invalid_or_missing_json_blocks(self):
        prefix = '<script id="dino-config" type="application/json">'
        good = '{"leaderboardApiUrl":""}'
        for document in (
                "<html><head></head><body></body></html>",
                prefix + good + "</script>" + prefix + good + "</script>",
                prefix + good, prefix + "{bad}" + "</script>", prefix + "[]" + "</script>",
                prefix + '{"leaderboardApiUrl":"","leaderboardApiUrl":"https://evil.invalid"}'
                + "</script>",
                prefix + '{"leaderboardApiUrl":"","unexpected":true}</script>',
                prefix + '{"leaderboardApiUrl":null}</script>',
                '<div id="dino-config">' + good + "</div>",
                '<script id="dino-config" type="text/javascript">' + good + "</script>",
                '<script id="dino-config" type="application/json" src="https://evil.invalid">'
                + good + "</script>",
                '<script id="dino-config" id="other" type="application/json">' + good + "</script>",
                '<script id="dino-config" type="application/json"/>'):
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    parse_game_config(document)


def run_checks(build, java_home, paths):
    (build.BUILD / "POLICY-CHECKS.json").unlink(missing_ok=True)
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ConfigurationChecks))
    build.require(result.wasSuccessful(), "Runtime-configuration checks failed.")
    check_root = build.safe_directory(build.BUILD / "policy-checks")
    old_outputs = {path: build.sha256(path) for path in (build.APK, build.LEGACY_APK)
                   if path.is_file()}
    keystore, password = build.development_key(java_home)
    signing_hash = build.sha256(keystore)
    reports = {}
    for mode, origin in (("offline", ""), ("configured", FAKE_API)):
        game = fixture_game(origin)
        config = parse_game_config(game)
        directory = check_root / mode
        build.compile_native(java_home, paths, config, directory)
        unsigned = build.assemble(game, config, directory)
        signed = directory / "fixture-check.apk"
        build.run(build.signer_command(java_home, paths, directory)
                  + ["sign", unsigned, signed, keystore, password])
        report = build.verify_apk(signed, game, java_home, paths, directory)
        build.verify_upgrade_identity(report, java_home, paths, directory)
        reports[mode] = report
        (directory / "fixture.html").write_bytes(game)
        build.require(report["permissions"] == expected_permissions(config),
                      "Fixture permission mismatch.")
        build.require(report["versionName"] == "1.2" and report["versionCode"] == 3
                      and report["appName"] == "Dinoinsel", "Upgrade metadata mismatch.")
        gradle_manifest = directory / "GradleManifest.xml"
        write_manifest(build.ANDROID / "src/main/AndroidManifest.xml",
                       gradle_manifest, config, for_gradle=True)
        gradle_root = ET.parse(gradle_manifest).getroot()
        build.require("package" not in gradle_root.attrib, "AGP manifest must omit package.")
        gradle_permissions = [element.get("{" + ANDROID_NAMESPACE + "}name")
                              for element in gradle_root.findall("uses-permission")]
        build.require(gradle_permissions == expected_permissions(config),
                      "Gradle and native manifest permissions differ.")

        mismatched_game = fixture_game(FAKE_API if not origin else "")
        rejected = False
        try:
            build.verify_apk(signed, mismatched_game, java_home, paths, directory)
        except RuntimeError:
            rejected = True
        build.require(rejected, "Verification accepted HTML/config/permission disagreement.")

        tampered = directory / "tampered-config.apk"
        with zipfile.ZipFile(unsigned) as source, zipfile.ZipFile(tampered, "w") as destination:
            for entry in source.infolist():
                data = source.read(entry)
                if entry.filename == CONFIG_ASSET:
                    data = config_bytes(parse_game_config(mismatched_game))
                destination.writestr(entry, data)
        rejected = False
        try:
            build.run(build.signer_command(java_home, paths, directory)
                      + ["verify", tampered], capture=True)
        except subprocess.CalledProcessError:
            rejected = True
        build.require(rejected, "An unsigned/tampered fixture must not verify.")
        signed_mismatch = directory / "signed-config-mismatch.apk"
        build.run(build.signer_command(java_home, paths, directory)
                  + ["sign", tampered, signed_mismatch, keystore, password])
        rejected = False
        try:
            build.verify_apk(signed_mismatch, game, java_home, paths, directory)
        except RuntimeError as error:
            rejected = "packaged runtime config differs" in str(error)
        build.require(rejected, "Verification accepted a validly signed but incorrect config asset.")
        signed_mismatch.unlink()
        tampered.unlink()
        rejected = False
        try:
            build.verify_apk(signed, game.replace(b"fixtureLoaded", b"anotherFixture"),
                             java_home, paths, directory)
        except RuntimeError as error:
            rejected = "packaged HTML differs" in str(error)
        build.require(rejected, "Verification accepted HTML with different source bytes.")
        print(build.verification_summary(report), flush=True)

    policy_classes = build.safe_directory(check_root / "java-checks")
    build.run([java_home / "bin/javac", "-J-Djava.io.tmpdir=" + str(build.TOOLS / "work"),
               "--release", "8", "-encoding", "UTF-8", "-g:none", "-d", policy_classes,
               build.ANDROID / "src/main/java/de/dinoinsel/game/NetworkPolicy.java",
               build.ANDROID / "checks/NetworkPolicyCheck.java"])
    runner = build.java_command(java_home) + ["-cp", policy_classes, "NetworkPolicyCheck"]
    build.run(runner)
    for mode, origin in (("offline", ""), ("configured", FAKE_API)):
        directory = check_root / mode
        build.run(runner + ["render", origin, directory / "fixture.html",
                           build.ANDROID / "src/main/assets/native-network.js",
                           check_root / (mode + ".html")])

    node = shutil.which("node")
    build.require(node, "Node.js is needed for the local mocked-browser policy checks.")
    build.run([node, build.ANDROID / "checks/browser-policy.mjs", check_root])
    build.require(signing_hash == build.sha256(keystore), "The original signing key changed.")
    for path, digest in old_outputs.items():
        build.require(path.is_file() and build.sha256(path) == digest,
                      "Self-tests modified an already delivered APK.")
    build.require(not build.APK.exists() or build.APK in old_outputs,
                  "Self-tests must never create a distribution APK.")
    summary = {
        "result": "passed",
        "configurationUnitTests": result.testsRun,
        "fixtures": {
            mode: {
                "permissions": report["permissions"],
                "signature": report["signature"],
                "appName": report["appName"],
                "versionName": report["versionName"],
                "versionCode": report["versionCode"],
                CONFIG_KEY: report[CONFIG_KEY],
                "runtimeConfigSha256": report["runtimeConfigSha256"],
            } for mode, report in reports.items()
        },
        "browser": json.loads((check_root / "browser-results.json").read_text()),
        "originalSigningKeyUnchanged": True,
        "distributionApksUnchanged": True,
        "liveApiRequests": 0,
        "androidDeviceTesting": False,
    }
    (build.BUILD / "POLICY-CHECKS.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("All native/configuration/manifest/mock-browser checks passed. "
          "No live API was contacted and no distribution APK was published.", flush=True)
