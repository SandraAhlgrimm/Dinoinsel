import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import com.android.apksig.KeyConfig;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;

public final class ApkTool {
    private static void sign(String[] args) throws Exception {
        char[] password = Files.readString(Path.of(args[4])).strip().toCharArray();
        try {
            KeyStore store = KeyStore.getInstance("PKCS12");
            try (InputStream input = Files.newInputStream(Path.of(args[3]))) {
                store.load(input, password);
            }
            String alias = "dino-insel-development";
            PrivateKey key = (PrivateKey) store.getKey(alias, password);
            X509Certificate certificate = (X509Certificate) store.getCertificate(alias);
            ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder(
                    alias, new KeyConfig.Jca(key), Collections.singletonList(certificate)).build();
            new ApkSigner.Builder(Collections.singletonList(signer))
                    .setInputApk(Path.of(args[1]).toFile())
                    .setOutputApk(Path.of(args[2]).toFile())
                    .setMinSdkVersion(26)
                    .setV1SigningEnabled(false)
                    .setV2SigningEnabled(true)
                    .setV3SigningEnabled(true)
                    .setV4SigningEnabled(false)
                    .setVerityEnabled(false)
                    .setAlignmentPreserved(true)
                    .setDebuggableApkPermitted(false)
                    .build()
                    .sign();
        } finally {
            Arrays.fill(password, '\0');
        }
    }

    private static void verify(String path) throws Exception {
        ApkVerifier.Result result = new ApkVerifier.Builder(Path.of(path).toFile())
                .setMinCheckedPlatformVersion(26)
                .setMaxCheckedPlatformVersion(35)
                .build()
                .verify();
        for (ApkVerifier.IssueWithParams warning : result.getWarnings()) {
            System.err.println("Signature warning: " + warning);
        }
        if (!result.isVerified() || !result.isVerifiedUsingV2Scheme()
                || !result.isVerifiedUsingV3Scheme()
                || result.getSignerCertificates().size() != 1) {
            throw new IllegalStateException("APK signature verification failed: "
                    + result.getAllErrors());
        }
        byte[] certificate = result.getSignerCertificates().get(0).getEncoded();
        String fingerprint = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(certificate));
        System.out.println("{\"verified\":true,\"v2\":true,\"v3\":true,"
                + "\"checkedApiMin\":26,\"checkedApiMax\":35,"
                + "\"certificateSha256\":\"" + fingerprint + "\"}");
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 5 && "sign".equals(args[0])) {
            sign(args);
        } else if (args.length == 2 && "verify".equals(args[0])) {
            verify(args[1]);
        } else {
            throw new IllegalArgumentException(
                    "Usage: ApkTool sign INPUT OUTPUT KEYSTORE PASSWORD_FILE | verify APK");
        }
    }
}
