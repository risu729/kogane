from __future__ import annotations

import argparse
import secrets
import signal
import socket
import subprocess
import threading
from pathlib import Path

import websocket

WORKER_NAME = "kogane-tamia-tcp-bridge-20260825"
DEFAULT_WORKER_URL = "wss://kogane-tamia-tcp-bridge-20260825.takuanimal.workers.dev"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 18787
MAX_CONNECT_HEADER_BYTES = 8 * 1024
BUFFER_BYTES = 16 * 1024

DESTINATIONS = {
    "tls.peet.ws:443": "/bridge/tls-peet",
    "www.smbc-card.com:443": "/bridge/vpass",
    "www.cloudflare.com:443": "/bridge/cloudflare-trace",
    "api.ipify.org:443": "/bridge/ipify",
}


def wrangler_secret(project_dir: Path, action: str, token: str | None = None) -> None:
    command = [
        "bunx",
        "wrangler",
        "secret",
        action,
        "BRIDGE_TOKEN",
        "--name",
        WORKER_NAME,
    ]
    input_text = f"{token}\n" if token is not None else "y\n"
    result = subprocess.run(
        command,
        cwd=project_dir,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"wrangler secret {action} failed with code {result.returncode}"
        )


def read_connect_request(client: socket.socket) -> tuple[str, bytes]:
    buffer = bytearray()
    while b"\r\n\r\n" not in buffer:
        chunk = client.recv(BUFFER_BYTES)
        if not chunk:
            raise ConnectionError("client closed before CONNECT")
        buffer.extend(chunk)
        if len(buffer) > MAX_CONNECT_HEADER_BYTES:
            raise ValueError("CONNECT header exceeded byte limit")
    header, trailing = bytes(buffer).split(b"\r\n\r\n", 1)
    request_line = header.split(b"\r\n", 1)[0].decode("ascii", "strict")
    parts = request_line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or parts[2] != "HTTP/1.1":
        raise ValueError("only HTTP/1.1 CONNECT is supported")
    authority = parts[1].lower()
    if authority not in DESTINATIONS:
        raise PermissionError("CONNECT destination is not allowlisted")
    return authority, trailing


def client_to_worker(
    client: socket.socket, worker: websocket.WebSocket, trailing: bytes
) -> None:
    try:
        if trailing:
            worker.send_binary(trailing)
        while True:
            try:
                chunk = client.recv(BUFFER_BYTES)
            except (ConnectionResetError, OSError):
                break
            if not chunk:
                break
            worker.send_binary(chunk)
    finally:
        worker.close()


def handle_client(
    client: socket.socket,
    token: str,
    worker_url: str,
) -> None:
    worker: websocket.WebSocket | None = None
    try:
        authority, trailing = read_connect_request(client)
        worker = websocket.create_connection(
            worker_url + DESTINATIONS[authority],
            header=[f"Authorization: Bearer {token}"],
            timeout=30,
            enable_multithread=True,
            skip_utf8_validation=True,
        )
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream = threading.Thread(
            target=client_to_worker,
            args=(client, worker, trailing),
            daemon=True,
        )
        upstream.start()
        while True:
            message = worker.recv()
            if message in (None, ""):
                break
            if not isinstance(message, bytes):
                raise TypeError("bridge returned a non-binary frame")
            client.sendall(message)
    except (
        ConnectionError,
        OSError,
        PermissionError,
        TypeError,
        ValueError,
        websocket.WebSocketException,
    ):
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
    finally:
        if worker is not None:
            worker.close()
        try:
            client.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-url", default=DEFAULT_WORKER_URL)
    args = parser.parse_args()
    project_dir = Path(__file__).resolve().parent.parent
    token = secrets.token_urlsafe(48)
    stop = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    wrangler_secret(project_dir, "put", token)
    print(
        f"bridge proxy listening on {LISTEN_HOST}:{LISTEN_PORT}; secret installed",
        flush=True,
    )
    try:
        with socket.create_server(
            (LISTEN_HOST, LISTEN_PORT), reuse_port=False
        ) as server:
            server.settimeout(0.5)
            while not stop.is_set():
                try:
                    client, _address = server.accept()
                except TimeoutError:
                    continue
                thread = threading.Thread(
                    target=handle_client,
                    args=(client, token, args.worker_url),
                    daemon=True,
                )
                thread.start()
    finally:
        token = ""
        try:
            wrangler_secret(project_dir, "delete")
            print("bridge secret deleted", flush=True)
        except RuntimeError:
            print(
                "bridge secret deletion failed; run the cleanup ledger command",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
