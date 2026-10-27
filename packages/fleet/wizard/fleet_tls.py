"""Keep OS trust and add a bundled public CA store to frozen installers."""
import ssl
import sys
import urllib.error
import urllib.request


def context():
    # Windows still trusts administrator-installed enterprise roots. Mozilla's
    # roots fill gaps on fresh/offline Windows installations and frozen Python.
    trust = ssl.create_default_context()
    if getattr(sys, "frozen", False):
        import certifi
        trust.load_verify_locations(cafile=certifi.where())
    return trust


def configure():
    if getattr(sys, "frozen", False):
        urllib.request.install_opener(urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context())))


def selftest():
    """Exercise real TLS in the final binary, including the release CDN's CA."""
    for url in ("https://github.com/robots.txt", "https://api.github.com/zen",
                "https://release-assets.githubusercontent.com/"):
        request = urllib.request.Request(url, headers={"User-Agent": "Fleet-installer-TLS-check"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                response.read(1)
        except urllib.error.HTTPError as response:
            # An HTTP error from an asset root still proves the TLS handshake;
            # there is deliberately no release/asset publication prerequisite.
            response.close()
        print(f"TLS verified: {url}", flush=True)
    print("HTTPS SELFTEST OK", flush=True)
    return 0


def advice(error):
    if error and ("certificate_verify_failed" in error.lower() or "certificate verify failed" in error.lower()):
        return ("This computer could not verify the download server's certificate. "
                "Use the latest Fleet installer, check Windows Update and the computer's clock, "
                "and ask your network administrator about HTTPS inspection if it continues. "
                "Keep certificate verification enabled.")
    return "Check this computer's internet connection and the Fleet release page, then try again."
