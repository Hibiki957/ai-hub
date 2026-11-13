#!/usr/bin/env python3
"""Create/reuse a local signing identity; never change system trust settings.

The non-exportable private key lives in the user's login keychain. The file in
Application Support contains only its public fingerprint and keychain path.
This is for locally built software, not Gatekeeper distribution/notarization.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def main():
    os.umask(0o077)
    directory = Path.home() / "Library/Application Support/AIHub/CodeSigning"
    config = directory / "identity.json"
    directory.mkdir(parents=True, exist_ok=True)
    if config.exists():
        identity = json.loads(config.read_text())
    else:
        keychain = run(["security", "default-keychain", "-d", "user"], text=True).strip().strip('"')
        name = "AI Hub Local Development"
        # Recover an identity if setup was interrupted after import. Never
        # silently rotate a key: rotation invalidates existing privacy grants.
        existing = run(["security", "find-identity", "-p", "codesigning", keychain], text=True)
        import re
        matches = set(re.findall(r'([0-9A-F]{40}) "' + re.escape(name) + '"', existing))
        if len(matches) > 1:
            raise RuntimeError("Multiple local signing identities; resolve explicitly before setup.")
        if matches:
            fingerprint = matches.pop()
        else:
            with tempfile.TemporaryDirectory(prefix="aihub-signing-") as temporary:
                temp = Path(temporary)
                (temp / "certificate.cnf").write_text("""[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no
[subject]
CN = AI Hub Local Development
[extensions]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
""")
                # OpenSSL receives the one-use wrapping password via environment;
                # do not put it in a shell, log, repository, or retained file.
                environment = dict(os.environ, AIHUB_P12_PASSWORD=secrets.token_urlsafe(32))
                run(["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:3072",
                     "-nodes", "-days", "3650", "-sha256", "-config", str(temp / "certificate.cnf"),
                     "-keyout", str(temp / "private.pem"), "-out", str(temp / "certificate.pem")])
                certificate = run(["/usr/bin/openssl", "x509", "-in", str(temp / "certificate.pem"), "-outform", "DER"])
                fingerprint = hashlib.sha1(certificate).hexdigest().upper()
                run(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", str(temp / "private.pem"),
                     "-in", str(temp / "certificate.pem"), "-name", name,
                     "-out", str(temp / "identity.p12"), "-passout", "env:AIHUB_P12_PASSWORD"], env=environment)
                # security import has no password-file option. Supply the random
                # one-use wrapping password directly, without printing arguments.
                run(["security", "import", str(temp / "identity.p12"), "-k", keychain,
                     "-f", "pkcs12", "-P", environment["AIHUB_P12_PASSWORD"], "-x", "-T", "/usr/bin/codesign"])
        identity = {"fingerprint": fingerprint, "keychain": keychain, "name": name}
        config.write_text(json.dumps(identity, indent=2) + "\n")

    import re
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", identity["fingerprint"]):
        raise RuntimeError("Invalid local signing fingerprint; configuration was not regenerated.")
    if not Path(identity["keychain"]).is_absolute():
        raise RuntimeError("Local signing keychain must use an absolute path.")

    # Prove that this key can sign and that a certificate-bound requirement is
    # satisfied before the installer is allowed to change the application.
    with tempfile.TemporaryDirectory(prefix="aihub-signing-check-") as temporary:
        temp = Path(temporary)
        (temp / "check.c").write_text("int main(void) { return 0; }\n")
        run(["xcrun", "clang", str(temp / "check.c"), "-o", str(temp / "check")])
        run(["codesign", "--force", "--sign", identity["fingerprint"], "--keychain", identity["keychain"],
             "--timestamp=none", "--identifier", "com.example.aihub.signing-check", str(temp / "check")])
        run(["codesign", "--verify", "--strict", "-R", '=certificate leaf = H"' + identity["fingerprint"] + '"', str(temp / "check")])
    print("Local signing identity ready: " + identity["fingerprint"])
    print("Public configuration: " + str(config))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Never include argv: import contains a one-use wrapping password.
        detail = error.stderr if isinstance(error.stderr, str) else error.stderr.decode(errors="replace")
        raise SystemExit("Local signing setup failed: " + detail.strip())
