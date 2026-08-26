from __future__ import annotations

import argparse
import json
import secrets
import subprocess
from pathlib import Path

from curl_cffi import requests


WORKER_NAME = "kogane-vpass-browser-run-20260825"
WORKER_URL = "https://kogane-vpass-browser-run-20260825.takuanimal.workers.dev"


def secret_command(project: Path, action: str, value: str | None = None) -> None:
    command = ["bunx", "wrangler", "secret", action, "PROBE_TOKEN", "--name", WORKER_NAME]
    input_text = f"{value}\n" if value is not None else "y\n"
    result = subprocess.run(
        command,
        cwd=project,
        input=input_text,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"wrangler secret {action} failed with code {result.returncode}")


def deploy_final(project: Path) -> None:
    result = subprocess.run(
        ["bun", "run", "deploy"],
        cwd=project,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"final Worker deploy failed with code {result.returncode}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("inspect", "login"))
    args = parser.parse_args()
    project = Path(__file__).resolve().parent.parent
    token = secrets.token_urlsafe(48)
    secret_command(project, "put", token)
    try:
        deploy_final(project)
        response = requests.post(
            f"{WORKER_URL}/{args.action}",
            headers={"Authorization": f"Bearer {token}"},
            impersonate="chrome150",
            timeout=60,
        )
        try:
            value = response.json()
        except json.JSONDecodeError:
            value = {
                "httpStatus": response.status_code,
                "contentType": response.headers.get("content-type"),
                "bodyPrefix": " ".join(response.text[:300].split()),
            }
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    finally:
        token = ""
        secret_command(project, "delete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
