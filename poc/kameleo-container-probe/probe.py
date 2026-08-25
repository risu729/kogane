import json
import os
import sys
from urllib.parse import urlsplit

from kameleo.local_api_client import KameleoLocalApiClient
from kameleo.local_api_client.models import BrowserSettings, CreateProfileRequest
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


LOGIN_PATH = "/memapi/jaxrs/xt_login/agree/v1"


def redacted_url(value: str) -> str:
    parsed = urlsplit(value)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


endpoint = os.environ.get("KAMELEO_ENDPOINT", "http://127.0.0.1:5050")
authenticate = "--auth" in sys.argv[1:]
keep_profile = os.environ.get("KEEP_PROFILE") == "1"
warmup = os.environ.get("WARMUP") == "1"
client = KameleoLocalApiClient(endpoint=endpoint)
client.verify_engine_ready()

profile_name = "kogane-vpass-persistent-windows-chrome"
profile = next(
    (item for item in client.profile.list_profiles() if item.name == profile_name),
    None,
)
if profile is None:
    fingerprints = client.fingerprint.search_fingerprints(
        device_type="desktop",
        os_family="windows",
        browser_product="chrome",
        browser_version=">145",
    )
    if not fingerprints:
        raise RuntimeError("no recent Windows Chrome fingerprint was returned")
    profile = client.profile.create_profile(
        CreateProfileRequest(
            fingerprintId=fingerprints[0].id,
            name=profile_name,
            language="ja-JP,ja",
        )
    )

result = {
    "engine": "kameleo-chroma",
    "requested_fingerprint": "windows/chrome/>145",
    "authenticate": authenticate,
    "persistent": keep_profile,
    "warmup": warmup,
}

try:
    # Cloudflare Containers does not expose Docker's --shm-size runtime knob.
    # Make Chromium use /tmp instead of the default 64 MiB /dev/shm mount.
    client.profile.start_profile(
        profile.id,
        BrowserSettings(arguments=["headless", "disable-dev-shm-usage"]),
        _request_timeout=180,
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(
            f"ws://127.0.0.1:5050/playwright/{profile.id}", timeout=90_000
        )
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()

        if warmup:
            page.goto(
                "https://www.smbc-card.com/",
                wait_until="domcontentloaded",
                timeout=45_000,
            )
            page.wait_for_timeout(2_000)
            page.mouse.move(180, 160, steps=12)
            page.mouse.wheel(0, 500)
            page.wait_for_timeout(1_200)
            page.mouse.move(740, 420, steps=18)
            page.mouse.wheel(0, -250)
            page.wait_for_timeout(1_500)

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

        login_page_response = page.goto(
            "https://www.smbc-card.com/mem/index.jsp",
            wait_until="domcontentloaded",
            timeout=45_000,
        )
        body = page.locator("body").inner_text(timeout=10_000)
        result["vpass"] = {
            "status": login_page_response.status if login_page_response else None,
            "url": redacted_url(page.url),
            "title": page.title(),
            "login_form": page.locator("#id_input").count() > 0
            and page.locator("#pw_input").count() > 0,
            "access_denied": "access denied"
            in f"{page.title()} {body[:2000]}".lower(),
        }

        if authenticate:
            print("READY_FOR_CREDENTIALS", file=sys.stderr, flush=True)
            user_id = sys.stdin.readline().rstrip("\r\n")
            password = sys.stdin.readline().rstrip("\r\n")
            if not user_id or not password:
                raise ValueError("two credential lines are required")

            id_input = page.locator("#id_input")
            password_input = page.locator("#pw_input")
            id_box = id_input.bounding_box()
            if id_box:
                page.mouse.move(
                    id_box["x"] + id_box["width"] / 2,
                    id_box["y"] + id_box["height"] / 2,
                    steps=24,
                )
                page.mouse.click(
                    id_box["x"] + id_box["width"] / 2,
                    id_box["y"] + id_box["height"] / 2,
                )
            else:
                id_input.click()
            page.keyboard.type(user_id, delay=115)
            page.wait_for_timeout(450)

            password_box = password_input.bounding_box()
            if password_box:
                page.mouse.move(
                    password_box["x"] + password_box["width"] / 2,
                    password_box["y"] + password_box["height"] / 2,
                    steps=18,
                )
                page.mouse.click(
                    password_box["x"] + password_box["width"] / 2,
                    password_box["y"] + password_box["height"] / 2,
                )
            else:
                password_input.click()
            page.keyboard.type(password, delay=95)
            result["interaction"] = {
                "id_length": len(id_input.input_value()),
                "password_length": len(password_input.input_value()),
            }
            user_id = ""
            password = ""
            page.wait_for_timeout(700)

            login_button = page.get_by_role("button", name="ログイン", exact=True)
            login_button.scroll_into_view_if_needed()
            page.wait_for_timeout(250)
            login_box = login_button.bounding_box()
            if login_box:
                page.mouse.move(
                    login_box["x"] + login_box["width"] / 2,
                    login_box["y"] + login_box["height"] / 2,
                    steps=28,
                )
                page.wait_for_timeout(350)

            login_response = None
            try:
                with page.expect_response(
                    lambda response: urlsplit(response.url).path == LOGIN_PATH,
                    timeout=30_000,
                ) as response_info:
                    if login_box:
                        page.mouse.click(
                            login_box["x"] + login_box["width"] / 2,
                            login_box["y"] + login_box["height"] / 2,
                        )
                    else:
                        login_button.click()
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
                "blocked": (
                    login_response is not None and login_response.status == 403
                )
                or "access denied" in body.lower(),
            }

        browser.close()
finally:
    try:
        client.profile.stop_profile(profile.id, _request_timeout=60)
    except Exception:
        pass
    if not keep_profile:
        try:
            client.profile.delete_profile(profile.id, _request_timeout=60)
        except Exception:
            pass

print(json.dumps(result, ensure_ascii=False, indent=2))
