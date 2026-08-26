import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from camoufox.sync_api import Camoufox
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError


def redacted_url(value: str) -> str:
    parsed = urlsplit(value)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


target_os = os.environ.get("TARGET_OS", "windows")
if target_os not in {"windows", "macos"}:
    raise ValueError("TARGET_OS must be windows or macos")
authenticate = "--auth" in sys.argv[1:]

profile_dir = os.environ.get("PROFILE_DIR")
options = {
    "os": target_os,
    "locale": "ja-JP",
    "geoip": True,
    "headless": "virtual",
    "humanize": True,
    "enable_cache": True,
    "fingerprint_preset": True,
}
if profile_dir:
    path = Path(profile_dir)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    options.update(persistent_context=True, user_data_dir=str(path))

result = {
    "target_os": target_os,
    "persistent": bool(profile_dir),
    "authenticate": authenticate,
}

with Camoufox(**options) as browser:
    page = browser.new_page()

    trace_response = page.goto(
        "https://www.cloudflare.com/cdn-cgi/trace",
        wait_until="domcontentloaded",
        timeout=30_000,
    )
    trace_fields = dict(
        line.split("=", 1)
        for line in page.locator("body").inner_text().splitlines()
        if "=" in line
    )
    result["egress"] = {
        "status": trace_response.status if trace_response else None,
        "country": trace_fields.get("loc"),
        "colo": trace_fields.get("colo"),
        "warp": trace_fields.get("warp"),
    }

    result["runtime"] = page.evaluate(
        """() => {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          const debug = gl?.getExtension('WEBGL_debug_renderer_info');
          return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            languages: navigator.languages,
            webdriver: navigator.webdriver,
            screen: {
              width: screen.width,
              height: screen.height,
              colorDepth: screen.colorDepth,
            },
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory ?? null,
            maxTouchPoints: navigator.maxTouchPoints,
            webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
            webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          };
        }"""
    )

    login_response = page.goto(
        "https://www.smbc-card.com/mem/index.jsp",
        wait_until="domcontentloaded",
        timeout=45_000,
    )
    body = page.locator("body").inner_text(timeout=10_000)
    result["vpass"] = {
        "status": login_response.status if login_response else None,
        "url": redacted_url(page.url),
        "title": page.title(),
        "login_form": page.locator("#id_input").count() > 0
        and page.locator("#pw_input").count() > 0,
        "access_denied": "access denied" in f"{page.title()} {body[:2000]}".lower(),
    }

    if authenticate:
        print("READY_FOR_CREDENTIALS", file=sys.stderr, flush=True)
        user_id = sys.stdin.readline().rstrip("\r\n")
        password = sys.stdin.readline().rstrip("\r\n")
        if not user_id or not password:
            raise ValueError("two credential lines are required")

        page.locator("#id_input").fill(user_id)
        page.locator("#pw_input").fill(password)
        user_id = ""
        password = ""

        login_response = None
        try:
            with page.expect_response(
                lambda response: urlsplit(response.url).path
                == "/memapi/jaxrs/xt_login/agree/v1",
                timeout=30_000,
            ) as response_info:
                page.get_by_role("button", name="ログイン", exact=True).click()
            login_response = response_info.value
        except PlaywrightTimeoutError:
            pass

        page.wait_for_timeout(5_000)
        body = page.locator("body").inner_text(timeout=10_000)
        result["login"] = {
            "response_status": login_response.status if login_response else None,
            "response_url": redacted_url(login_response.url)
            if login_response
            else None,
            "login_result_header": login_response.headers.get("x-loginresult")
            if login_response
            else None,
            "final_url": redacted_url(page.url),
            "title": page.title(),
            "authenticated": page.get_by_role(
                "link", name="ログアウト", exact=True
            ).count()
            > 0
            or "操作中のカードを変更する" in body,
            "blocked": (login_response is not None and login_response.status == 403)
            or "access denied" in body.lower(),
        }

print(json.dumps(result, ensure_ascii=False, indent=2))
