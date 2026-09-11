from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import time
from collections.abc import Mapping
from typing import Any
from urllib.parse import urljoin, urlparse

from curl_cffi import requests

BASE_URL = "https://www.smbc-card.com"
MYPAGE_PATH = "/memx/mypage/index.html"
LOGIN_PAGE_PATH = "/mem/index.jsp"
UA_DEVICE_PATH = "/memapi/jaxrs/services/api/UAService/getDevice/v1"
LOGIN_PATH = "/memapi/jaxrs/xt_login/agree/v1"
CARD_LIST_PATH = "/memapi/jaxrs/multicard/dropdownlist_init/v1"
CARD_SELECT_PATH = "/memapi/jaxrs/multicard/operation_card_update/v1"
MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1"
TLS_PROBE_URL = "https://tls.peet.ws/api/all"

PROFILES = ("chrome116", "chrome142", "chrome150")


def adler32(value: str) -> int:
    a = 1
    b = 0
    for byte in value.encode():
        a = (a + byte) % 65_521
        b = (b + a) % 65_521
    return ((b << 16) | a) & 0xFFFFFFFF


def wrapped_body(path: str, content: Mapping[str, object]) -> dict[str, object]:
    return {
        "header": {
            "requestHash": adler32(path),
            "requestTimestamp": int(time.time() * 1000),
            "corpCode": "",
        },
        "body": {"content": dict(content)},
    }


def cookie_names(session: requests.Session) -> list[str]:
    return sorted({cookie.name for cookie in session.cookies.jar})


def safe_url(value: str | None) -> dict[str, str] | None:
    if not value:
        return None
    parsed = urlparse(value)
    return {"hostname": parsed.hostname or "", "path": parsed.path}


def assert_vpass_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "www.smbc-card.com":
        raise RuntimeError("Vpass redirected outside the allowlisted host")


def response_summary(response: requests.Response) -> dict[str, object]:
    assert_vpass_url(response.url)
    for prior in response.history:
        assert_vpass_url(prior.url)
    return {
        "status": response.status_code,
        "url": safe_url(response.url),
        "contentType": response.headers.get("content-type"),
    }


def make_session(profile: str, proxy: str | None) -> requests.Session:
    return requests.Session(
        impersonate=profile,
        proxy=proxy,
        trust_env=False,
        timeout=30,
        headers={"accept-language": "ja,en-US;q=0.9,en;q=0.8"},
    )


def fingerprint(profile: str, proxy: str | None, label: str) -> None:
    with make_session(profile, proxy) as session:
        response = session.get(TLS_PROBE_URL, allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"TLS diagnostic returned {response.status_code}")
        value: Any = response.json()
        ip = value.get("ip") if isinstance(value, dict) else None
        if not isinstance(ip, str):
            raise RuntimeError("TLS diagnostic returned no IP")
        tls = value.get("tls") if isinstance(value.get("tls"), dict) else {}
        http2 = value.get("http2") if isinstance(value.get("http2"), dict) else {}
        print(
            json.dumps(
                {
                    "mode": "fingerprint",
                    "label": label,
                    "profile": profile,
                    "status": response.status_code,
                    "ipHash": hashlib.sha256(ip.encode()).hexdigest(),
                    "httpVersion": value.get("http_version"),
                    "userAgent": value.get("user_agent"),
                    "ja3Hash": tls.get("ja3_hash"),
                    "ja4": tls.get("ja4"),
                    "akamaiFingerprint": http2.get("akamai_fingerprint"),
                    "akamaiFingerprintHash": http2.get("akamai_fingerprint_hash"),
                },
                ensure_ascii=False,
            ),
        )


class VpassProbe:
    def __init__(self, profile: str, proxy: str | None) -> None:
        self.session = make_session(profile, proxy)
        self.authenticated = False

    def close(self) -> None:
        self.session.close()

    def bootstrap(self) -> list[dict[str, object]]:
        results: list[dict[str, object]] = []
        top = self.session.get(BASE_URL + MYPAGE_PATH, allow_redirects=True)
        if not 200 <= top.status_code < 300:
            raise RuntimeError(f"Vpass top failed with {top.status_code}")
        results.append({"step": "top", **response_summary(top)})

        device = self.api_post(UA_DEVICE_PATH, {}, require_login=False)
        results.append({"step": "device", **response_summary(device)})

        login_page = self.session.get(BASE_URL + LOGIN_PAGE_PATH, allow_redirects=True)
        if not 200 <= login_page.status_code < 300:
            raise RuntimeError(f"login page failed with {login_page.status_code}")
        results.append({"step": "login-page", **response_summary(login_page)})
        self.session.cookies.set(
            "layout_mode",
            "PC",
            domain="www.smbc-card.com",
            path="/",
            secure=True,
        )
        return results

    def login(self, user_id: str, password: str) -> dict[str, object]:
        response = self.session.post(
            BASE_URL + LOGIN_PATH,
            data={"userid": user_id, "password": password},
            allow_redirects=False,
            headers={
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "content-type": "application/x-www-form-urlencoded",
                "origin": BASE_URL,
                "referer": BASE_URL + LOGIN_PAGE_PATH,
            },
        )
        location = response.headers.get("location")
        summary = {
            "status": response.status_code,
            "loginResult": response.headers.get("x-loginresult"),
            "location": safe_url(urljoin(BASE_URL, location)) if location else None,
            "contentType": response.headers.get("content-type"),
            "cookieNames": cookie_names(self.session),
        }
        if not (
            300 <= response.status_code < 400
            and response.headers.get("x-loginresult") == "0"
            and location
        ):
            return summary

        next_url = urljoin(BASE_URL, location)
        assert_vpass_url(next_url)
        follow = self.session.get(next_url, allow_redirects=True)
        if not 200 <= follow.status_code < 300:
            raise RuntimeError(f"login redirect failed with {follow.status_code}")
        authenticated_top = self.session.get(
            BASE_URL + MYPAGE_PATH, allow_redirects=True
        )
        if not 200 <= authenticated_top.status_code < 300:
            raise RuntimeError(
                f"authenticated top failed with {authenticated_top.status_code}"
            )
        self.authenticated = True
        return summary

    def api_post(
        self,
        path: str,
        content: Mapping[str, object],
        *,
        require_login: bool = True,
    ) -> requests.Response:
        if require_login and not self.authenticated:
            raise RuntimeError("Vpass login is required")
        response = self.session.post(
            BASE_URL + path,
            json=wrapped_body(path, content),
            allow_redirects=False,
            headers={
                "accept": "application/json, text/javascript, */*; q=0.01",
                "content-type": "application/json",
                "origin": BASE_URL,
                "referer": BASE_URL + MYPAGE_PATH,
                "x-requested-with": "XMLHttpRequest",
            },
        )
        if response.status_code in (401, 403, 429):
            raise RuntimeError(f"{path} was rejected with {response.status_code}")
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"{path} failed with {response.status_code}")
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type.lower():
            raise RuntimeError(f"{path} returned a non-JSON response")
        return response

    def authenticated_summary(self) -> dict[str, object]:
        response = self.api_post(CARD_LIST_PATH, {"displayDropdownList": "enable"})
        value: Any = response.json()
        bean = (
            value.get("body", {})
            .get("content", {})
            .get("DropdownListInitDisplayServiceBean", {})
            if isinstance(value, dict)
            else {}
        )
        cards = bean.get("multiCardInfoList", []) if isinstance(bean, dict) else []
        card_values = [
            card.get("value")
            for card in cards
            if isinstance(card, dict) and isinstance(card.get("value"), str)
        ]
        if not card_values:
            raise RuntimeError("Vpass returned no cards")
        self.api_post(CARD_SELECT_PATH, {"cardIdentifyKey": card_values[0]})
        months_response = self.api_post(MEISAI_TOP_PATH, {})
        months_value: Any = months_response.json()
        content = months_value.get("body", {}).get("content", {})
        months: set[str] = set()
        if isinstance(content, dict):
            for bean_name, field in (
                ("WebMeisaiTopDisplayServiceBean", "seikyuYMList"),
                ("WebMeisaiCommonDisplayServiceBean", "comSeikyuYMList"),
                ("CustomizedMeisaiAnsDisplayServiceBean", "seikyuYMList"),
            ):
                current = content.get(bean_name, {})
                pairs = current.get(field, []) if isinstance(current, dict) else []
                for pair in pairs:
                    candidate = pair.get("value") if isinstance(pair, dict) else None
                    if (
                        isinstance(candidate, str)
                        and len(candidate) == 6
                        and candidate.isdigit()
                    ):
                        months.add(candidate)
        return {"cardCount": len(card_values), "availableMonthCount": len(months)}


def bootstrap(profile: str, proxy: str | None, label: str) -> None:
    probe = VpassProbe(profile, proxy)
    try:
        steps = probe.bootstrap()
        print(
            json.dumps(
                {
                    "mode": "bootstrap",
                    "label": label,
                    "profile": profile,
                    "steps": steps,
                    "cookieNames": cookie_names(probe.session),
                },
                ensure_ascii=False,
            ),
        )
    finally:
        probe.close()


def login(profile: str, proxy: str | None, label: str) -> int:
    probe = VpassProbe(profile, proxy)
    user_id = getpass.getpass("Vpass ID (masked): ")
    password = getpass.getpass("Vpass password (masked): ")
    try:
        steps = probe.bootstrap()
        result = probe.login(user_id, password)
        user_id = ""
        password = ""
        output: dict[str, object] = {
            "mode": "login",
            "label": label,
            "profile": profile,
            "bootstrap": steps,
            "login": result,
            "authenticated": probe.authenticated,
        }
        if probe.authenticated:
            output["account"] = probe.authenticated_summary()
        print(json.dumps(output, ensure_ascii=False))
        return 0 if probe.authenticated else 2
    finally:
        user_id = ""
        password = ""
        probe.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("fingerprint", "bootstrap", "login"))
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--proxy")
    parser.add_argument("--label", required=True)
    args = parser.parse_args()

    if args.mode == "fingerprint":
        fingerprint(args.profile, args.proxy, args.label)
        return 0
    if args.mode == "bootstrap":
        bootstrap(args.profile, args.proxy, args.label)
        return 0
    return login(args.profile, args.proxy, args.label)


if __name__ == "__main__":
    raise SystemExit(main())
