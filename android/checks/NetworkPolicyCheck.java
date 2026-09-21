import de.dinoinsel.game.NetworkPolicy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class NetworkPolicyCheck {
    private static final String API = "https://dinoinsel-test.azurewebsites.net";
    private static int checks;

    private static void check(boolean condition, String description) {
        checks++;
        if (!condition) {
            throw new AssertionError(description);
        }
    }

    private static void runChecks() {
        NetworkPolicy offline = new NetworkPolicy("");
        NetworkPolicy online = new NetworkPolicy(API);
        check(!offline.isNetworkEnabled(), "Empty config must disable network loads.");
        check(online.isNetworkEnabled(), "An explicit origin must enable the restricted API.");
        check("https://dino-insel.invalid/".equals(NetworkPolicy.LOCAL_ORIGIN),
                "The persisted WebView origin must never change during an upgrade.");

        for (String method : new String[]{"GET", "POST", "DELETE", "OPTIONS"}) {
            check(online.allowsRequest(API + "/api/groups?order=score", method, false),
                    "Allow the required API method " + method);
            check(!online.allowsRequest(API + "/api/groups", method, true),
                    "Even an API URL must not become the main document.");
            check(!offline.allowsRequest(API + "/api/groups", method, false),
                    "Offline config must block " + method);
        }
        check(online.allowsRequest(API + ":443/api/groups", "GET", false),
                "The implicit and explicit standard HTTPS port denote the same origin.");
        check(online.allowsRequest(API.toUpperCase() + "/api/groups", "GET", false),
                "Host/scheme matching follows origin case normalization.");
        check(online.allowsRequest(API + "/api/groups/a-b_2/scores?name=Max%20Muster", "GET", false),
                "API routes and encoded query values remain usable.");

        for (String value : new String[]{
                "http://dinoinsel-test.azurewebsites.net/api/groups",
                "https://elsewhere.invalid/api/groups",
                "https://dinoinsel-test.azurewebsites.net.evil.invalid/api/groups",
                "https://dinoinsel-test.azurewebsites.net@evil.invalid/api/groups",
                "https://user:secret@dinoinsel-test.azurewebsites.net/api/groups",
                API + ":444/api/groups", API + "/", API + "/api", API + "/API/groups",
                API + "/api-other/groups", API + "/api/../private",
                API + "/api/%2e%2e/private", API + "/api/.%2e/private",
                API + "/api/%252e%252e/private", API + "/api/a%2fb",
                API + "/api/a%5cb", API + "/api//groups", API + "/api/a%00b",
                API + "/api/a%0db", API + "/api/a\\b", API + "/api/groups#token",
                "file:///api/groups", "content://api/groups", "data:text/plain,hello",
                "blob:https://dino-insel.invalid/test", "javascript:alert(1)",
                "https:///api/groups", "not a URL", API + "/api/%zz"
        }) {
            check(!online.allowsRequest(value, "GET", false), "Reject " + value);
        }
        for (String method : new String[]{"HEAD", "PUT", "PATCH", "TRACE", "CONNECT", "get", ""}) {
            check(!online.allowsRequest(API + "/api/groups", method, false),
                    "Reject non-API method " + method);
        }
        NetworkPolicy port = new NetworkPolicy(API + ":8443");
        check(port.allowsRequest(API + ":8443/api/groups", "GET", false), "Allow configured port.");
        check(!port.allowsRequest(API + "/api/groups", "GET", false), "Reject a different port.");
        NetworkPolicy ipv6 = new NetworkPolicy("https://[2001:db8::1]:8443");
        check(ipv6.allowsRequest("https://[2001:db8::1]:8443/api/groups", "GET", false),
                "Canonical IPv6 origins are supported without DNS.");

        for (String origin : new String[]{
                "http://example.com", "https://example.com/", "https://user@example.com",
                "https://example.com/api", "https://example.com?x=1",
                "https://example.com#x", "https://example.com:443",
                "https://example.com:65536", "https://*.example.com", " https://example.com"
        }) {
            boolean rejected = false;
            try {
                new NetworkPolicy(origin);
            } catch (IllegalArgumentException exception) {
                rejected = true;
            }
            check(rejected, "Reject invalid/noncanonical embedded origin " + origin);
        }

        String html = "<!doctype html><html><head><script>window.fixture=true;</script>"
                + "</head><body></body></html>";
        String bootstrap = "window.originFixture=__DINO_ALLOWED_ORIGIN_JSON__;";
        String protectedHtml = online.protectHtml(html, bootstrap);
        check(protectedHtml.contains("connect-src " + API + "/api/;"),
                "CSP must restrict connections to this API path.");
        check(protectedHtml.contains("script-src 'sha256-")
                        && !protectedHtml.contains("script-src 'unsafe-inline'"),
                "Only the known bundled scripts receive executable CSP hashes.");
        check(protectedHtml.indexOf("Content-Security-Policy")
                        < protectedHtml.indexOf("window.fixture=true"),
                "Policy must precede every game script.");
        check(protectedHtml.contains("window.originFixture=\"" + API + "\";"),
                "The guard receives the explicitly configured origin.");
        check(offline.protectHtml(html, bootstrap).contains("connect-src 'none';"),
                "Offline CSP must deny every connection.");
        check(!protectedHtml.contains("__DINO_ALLOWED_ORIGIN_JSON__"),
                "No unresolved guard configuration may remain.");
        System.out.println("Native Java network-policy checks passed: " + checks);
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            runChecks();
            return;
        }
        if (args.length != 5 || !"render".equals(args[0])) {
            throw new IllegalArgumentException("Usage: render ORIGIN HTML GUARD OUTPUT");
        }
        Path source = Paths.get(args[2]);
        Path guard = Paths.get(args[3]);
        String result = new NetworkPolicy(args[1]).protectHtml(
                new String(Files.readAllBytes(source), StandardCharsets.UTF_8),
                new String(Files.readAllBytes(guard), StandardCharsets.UTF_8));
        Files.write(Paths.get(args[4]), result.getBytes(StandardCharsets.UTF_8));
    }
}
