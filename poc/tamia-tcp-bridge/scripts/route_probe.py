from __future__ import annotations

import hashlib
import json

from curl_cffi import requests


PROXY = "http://127.0.0.1:18787"


def hash_ip(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def main() -> int:
    session = requests.Session(impersonate="chrome116", proxy=PROXY, trust_env=False)
    trace_response = session.get(
        "https://www.cloudflare.com/cdn-cgi/trace",
        timeout=30,
    )
    trace_response.raise_for_status()
    trace = dict(
        line.split("=", 1)
        for line in trace_response.text.splitlines()
        if "=" in line
    )
    ipify_response = session.get(
        "https://api.ipify.org?format=json",
        timeout=30,
    )
    ipify_response.raise_for_status()
    ipify_ip = str(ipify_response.json()["ip"])
    output = {
        "trace": {
            "ipHash": hash_ip(str(trace.get("ip", ""))),
            "loc": trace.get("loc"),
            "warp": trace.get("warp"),
            "gateway": trace.get("gateway"),
        },
        "ipify": {"ipHash": hash_ip(ipify_ip)},
        "sameIp": trace.get("ip") == ipify_ip,
    }
    print(json.dumps(output, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
