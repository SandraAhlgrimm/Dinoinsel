package de.dinoinsel.game;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class NetworkPolicy {
    public static final String LOCAL_ORIGIN = "https://dino-insel.invalid/";
    private static final Pattern HEAD = Pattern.compile("<head\\b[^>]*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCRIPT = Pattern.compile(
            "<script\\b[^>]*>(.*?)</script\\s*>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern ORIGIN = Pattern.compile(
            "https://(?:\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)(?::[1-9][0-9]{0,4})?");
    private static final String CONFIG_TOKEN = "__DINO_ALLOWED_ORIGIN_JSON__";

    private final String origin;
    private final URI endpoint;

    public NetworkPolicy(String configuredOrigin) {
        origin = configuredOrigin;
        if (origin.isEmpty()) {
            endpoint = null;
            return;
        }
        try {
            endpoint = new URI(origin);
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException("Invalid embedded API origin.", exception);
        }
        if (!ORIGIN.matcher(origin).matches() || endpoint.getHost() == null
                || endpoint.getRawUserInfo() != null || !endpoint.getRawPath().isEmpty()
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || endpoint.getPort() == 443 || endpoint.getPort() > 65535) {
            throw new IllegalArgumentException("The embedded API origin must be canonical HTTPS.");
        }
    }

    public boolean isNetworkEnabled() {
        return endpoint != null;
    }

    public boolean allowsRequest(String value, String method, boolean mainFrame) {
        if (endpoint == null || mainFrame || !("GET".equals(method) || "POST".equals(method)
                || "DELETE".equals(method) || "OPTIONS".equals(method))) {
            return false;
        }
        try {
            URI request = new URI(value);
            String rawPath = request.getRawPath();
            String path = request.getPath();
            if (!"https".equalsIgnoreCase(request.getScheme())
                    || request.getHost() == null
                    || !endpoint.getHost().equalsIgnoreCase(request.getHost())
                    || port(endpoint) != port(request)
                    || request.getRawUserInfo() != null || request.getRawFragment() != null
                    || rawPath == null || !rawPath.startsWith("/api/")
                    || path == null || !path.startsWith("/api/")
                    || path.contains("\\") || path.contains("//")
                    || rawPath.toLowerCase(Locale.ROOT).matches(".*%(?:2f|5c|25).*")
                    || !request.normalize().getRawPath().equals(rawPath)) {
                return false;
            }
            for (String segment : path.split("/")) {
                if (".".equals(segment) || "..".equals(segment)) {
                    return false;
                }
            }
            for (int index = 0; index < path.length(); index++) {
                if (Character.isISOControl(path.charAt(index))) {
                    return false;
                }
            }
            return true;
        } catch (URISyntaxException | IllegalArgumentException exception) {
            return false;
        }
    }

    private static int port(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }

    private static String scriptHash(String script) {
        try {
            String normalized = script.replace("\r\n", "\n").replace('\r', '\n')
                    .replace('\0', '\ufffd');
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(normalized.getBytes(StandardCharsets.UTF_8));
            return "'sha256-" + Base64.getEncoder().encodeToString(digest) + "'";
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable.", exception);
        }
    }

    public String protectHtml(String html, String bootstrapTemplate) {
        Matcher head = HEAD.matcher(html);
        if (!head.find() || !bootstrapTemplate.contains(CONFIG_TOKEN)
                || bootstrapTemplate.indexOf(CONFIG_TOKEN) != bootstrapTemplate.lastIndexOf(CONFIG_TOKEN)
                || bootstrapTemplate.toLowerCase(Locale.ROOT).contains("</script")) {
            throw new IllegalArgumentException("The bundled document or network policy is incomplete.");
        }
        String bootstrap = bootstrapTemplate.replace(CONFIG_TOKEN, "\"" + origin + "\"");
        Set<String> hashes = new LinkedHashSet<>();
        hashes.add(scriptHash(bootstrap));
        Matcher scripts = SCRIPT.matcher(html);
        while (scripts.find()) {
            hashes.add(scriptHash(scripts.group(1)));
        }
        StringBuilder scriptSources = new StringBuilder();
        for (String hash : hashes) {
            scriptSources.append(hash).append(' ');
        }
        // Hashes allow only bundled scripts; fetched JSON cannot add executable inline code.
        String csp = "default-src 'none'; script-src " + scriptSources.toString().trim()
                + "; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:"
                + "; media-src data: blob:; connect-src "
                + (endpoint == null ? "'none'" : origin + "/api/")
                + "; frame-src 'none'; worker-src 'none'; object-src 'none'"
                + "; base-uri 'none'; form-action 'none';";
        String prefix = "<meta http-equiv=\"Content-Security-Policy\" content=\"" + csp
                + "\"><script>" + bootstrap + "</script>";
        return html.substring(0, head.end()) + prefix + html.substring(head.end());
    }
}
