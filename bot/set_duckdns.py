"""Set DuckDNS A-record to GitHub Pages IPs and generate CNAME for the site.

Usage:
  1. Register free at https://www.duckdns.org (sign in with GitHub/Google/Reddit).
  2. Create a subdomain, e.g. "aifoodbot"  ->  aifoodbot.duckdns.org
  3. Copy your DuckDNS token from the dashboard.
  4. Set environment variables (PowerShell):
       $env:DUCKDNS_TOKEN="your-token-here"
       $env:DUCKDNS_DOMAIN="aifoodbot"
       python set_duckdns.py
  5. Add the printed CNAME in GitHub repo: Settings -> Pages -> Custom domain
     (the script also writes docs/CNAME automatically).

Note: DuckDNS stores ONE IPv4 per domain. GitHub Pages serves from 4 IPs,
but pointing to 185.199.108.153 works for the custom-domain setup.
"""
import os
import sys

GITHUB_PAGES_IP = "185.199.108.153"  # primary GitHub Pages IP


def main():
    token = os.environ.get("DUCKDNS_TOKEN", "").strip()
    domain = os.environ.get("DUCKDNS_DOMAIN", "").strip()

    if not token or not domain:
        print("ERROR: set DUCKDNS_TOKEN and DUCKDNS_DOMAIN environment variables first.")
        print("Example: aifoodbot -> aifoodbot.duckdns.org")
        sys.exit(1)

    # Update DuckDNS A-record via its HTTP API
    import urllib.request
    url = (
        f"https://www.duckdns.org/update"
        f"?domains={domain}&token={token}&ip={GITHUB_PAGES_IP}&clear=false"
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            result = resp.read().decode().strip()
        if "OK" in result.upper():
            print(f"✅ DuckDNS updated: {domain}.duckdns.org -> {GITHUB_PAGES_IP}")
        else:
            print(f"⚠️ DuckDNS response: {result!r} (check token/domain)")
    except Exception as e:
        print(f"⚠️ DuckDNS update failed: {e}")

    # Write CNAME into docs/ so GitHub Pages picks it up on deploy
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cname_path = os.path.join(base, "docs", "CNAME")
    full_domain = f"{domain}.duckdns.org"
    with open(cname_path, "w", encoding="utf-8") as f:
        f.write(full_domain + "\n")
    print(f"✅ Wrote docs/CNAME -> {full_domain}")
    print(f"👉 Next: GitHub repo Settings -> Pages -> Custom domain: {full_domain}")
    print(f"👉 Then rebuild: git add -A && git commit -m 'Set custom domain' && git push")


if __name__ == "__main__":
    main()
