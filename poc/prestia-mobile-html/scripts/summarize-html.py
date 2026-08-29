#!/usr/bin/env python3
"""Print a value-free structural summary of a PRESTIA HTML response."""

from __future__ import annotations

import json
import sys
from html.parser import HTMLParser
from pathlib import Path


class FormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, object]] = []
        self.current: dict[str, object] | None = None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attributes = dict(attrs)
        if tag == "form":
            action = attributes.get("action") or ""
            self.current = {
                "name": attributes.get("name"),
                "method": attributes.get("method"),
                # Do not print the action itself: some deployments may place
                # session material in either its query or path segments.
                "actionPresent": bool(action),
                "inputs": [],
            }
            self.forms.append(self.current)
        elif tag == "input" and self.current is not None:
            inputs = self.current["inputs"]
            assert isinstance(inputs, list)
            inputs.append(
                {
                    "name": attributes.get("name"),
                    "type": attributes.get("type"),
                    "hasValue": bool(attributes.get("value")),
                }
            )

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self.current = None


def decode_html(raw: bytes) -> tuple[str, str]:
    for encoding in ("utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8-replacement"


def main() -> None:
    raw = Path(sys.argv[1]).read_bytes()
    text, encoding = decode_html(raw)
    parser = FormParser()
    parser.feed(text)
    print(
        json.dumps(
            {"bytes": len(raw), "encoding": encoding, "forms": parser.forms},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
