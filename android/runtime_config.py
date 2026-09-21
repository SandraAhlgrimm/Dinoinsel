"""Strict build-time configuration; the bundled HTML is the only configuration source."""

import ipaddress
import json
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET


ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
INTERNET_PERMISSION = "android.permission.INTERNET"
CONFIG_ASSET = "assets/runtime-config.json"
NETWORK_ASSET = "assets/native-network.js"
CONFIG_KEY = "leaderboardApiUrl"
ET.register_namespace("android", ANDROID_NAMESPACE)


def canonical_origin(value):
    if not isinstance(value, str):
        raise ValueError("leaderboardApiUrl must be a string (empty means offline).")
    if not value:
        return ""
    match = re.fullmatch(
        r"https://(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?",
        value, re.IGNORECASE)
    if not match:
        raise ValueError("leaderboardApiUrl must be an HTTPS origin only: no path, trailing "
                         "slash, credentials, query, fragment, whitespace or wildcard.")
    host = match.group(1).lower()
    if host.startswith("["):
        host = "[" + ipaddress.IPv6Address(host[1:-1]).compressed + "]"
    else:
        labels = host.split(".")
        if len(host) > 253 or any(not re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
            raise ValueError("leaderboardApiUrl has an invalid ASCII hostname.")
        if re.fullmatch(r"[0-9.]+", host):
            host = str(ipaddress.IPv4Address(host))
        elif re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)", labels[-1]):
            raise ValueError("Noncanonical numeric hostnames are not allowed.")
    port = int(match.group(2)) if match.group(2) else 443
    if not 1 <= port <= 65535:
        raise ValueError("leaderboardApiUrl has an invalid HTTPS port.")
    return "https://" + host + (":" + str(port) if port != 443 else "")


class _ConfigParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.count = 0
        self.inside = False
        self.complete = False
        self.parts = []

    def handle_starttag(self, tag, attributes):
        if any(name == "id" and value == "dino-config" for name, value in attributes):
            self.count += 1
            names = [name for name, unused in attributes]
            attrs = dict(attributes)
            if (tag != "script" or len(names) != len(set(names))
                    or attrs.get("type", "").lower() != "application/json"
                    or "src" in attrs):
                raise ValueError("dino-config must be one inline application/json script.")
            self.inside = True

    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)
        if self.inside:
            raise ValueError("dino-config requires a closing </script> tag.")

    def handle_endtag(self, tag):
        if tag == "script" and self.inside:
            self.inside = False
            self.complete = True

    def handle_data(self, value):
        if self.inside:
            self.parts.append(value)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON configuration key: " + key)
        result[key] = value
    return result


def parse_game_config(game):
    text = game.decode("utf-8") if isinstance(game, bytes) else game
    parser = _ConfigParser()
    parser.feed(text)
    parser.close()
    if parser.count != 1 or not parser.complete or parser.inside:
        raise ValueError("Expected exactly one complete inline script with id=\"dino-config\". "
                         "Missing or malformed configuration is not silently treated as offline.")
    config = json.loads("".join(parser.parts), object_pairs_hook=_unique_object)
    if not isinstance(config, dict) or set(config) != {CONFIG_KEY}:
        raise ValueError("dino-config must contain exactly the leaderboardApiUrl field.")
    return {CONFIG_KEY: canonical_origin(config[CONFIG_KEY])}


def offline_config():
    return {CONFIG_KEY: ""}


def config_bytes(config):
    return (json.dumps(config, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")


def expected_permissions(config):
    return [INTERNET_PERMISSION] if config[CONFIG_KEY] else []


def write_manifest(source, target, config, for_gradle=False):
    document = ET.parse(source)
    root = document.getroot()
    if any(element.tag.startswith("uses-permission") for element in root):
        raise ValueError("Keep the source manifest permission-free; permissions are derived "
                         "only from the validated bundled game configuration.")
    if for_gradle:
        root.attrib.pop("package", None)
    for permission in expected_permissions(config):
        entry = ET.Element("uses-permission", {
            "{" + ANDROID_NAMESPACE + "}name": permission})
        root.insert(0, entry)
    target.parent.mkdir(parents=True, exist_ok=True)
    document.write(target, encoding="utf-8", xml_declaration=True)


def prepare_gradle():
    android = Path(__file__).resolve().parent
    game = android.parent / "game/index.html"
    game_data = game.read_bytes()
    config = parse_game_config(game_data)
    generated = android / "build/gradle-inputs"
    if not generated.resolve().is_relative_to(android):
        raise ValueError("Gradle inputs must stay within the Android build directory.")
    assets = generated / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "index.html").write_bytes(game_data)
    (assets / "runtime-config.json").write_bytes(config_bytes(config))
    shutil.copyfile(android / "src/main/assets/native-network.js", assets / "native-network.js")
    write_manifest(android / "src/main/AndroidManifest.xml",
                   generated / "AndroidManifest.xml", config, for_gradle=True)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] != ["--gradle"]:
        raise SystemExit("Usage: python3 runtime_config.py --gradle")
    prepare_gradle()
