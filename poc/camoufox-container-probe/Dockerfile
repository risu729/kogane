# syntax=docker/dockerfile:1

FROM python:3.12.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/camoufox \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      dbus-x11 \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo-gobject2 \
      libdbus-1-3 \
      libdbus-glib-1-2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxrandr2 \
      libxrender1 \
      libxt6 \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 camoufox

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --requirement /tmp/requirements.txt

# Camoufox currently hard-codes a 20-second GitHub API timeout. That is too
# short on some container egress paths, and its `set` command can still return
# success after every repository timed out. Widen the timeout, sync explicitly,
# and assert that the browser executable was actually installed.
RUN sed -i 's/timeout=20/timeout=120/' \
      /usr/local/lib/python3.12/site-packages/camoufox/pkgman.py

USER camoufox
RUN python -m camoufox sync \
    && python -m camoufox set official/stable \
    && python -m camoufox fetch \
    && test -x "$(python -m camoufox path)"

WORKDIR /app
COPY --chown=camoufox:camoufox probe.py ./probe.py

ENTRYPOINT ["python", "/app/probe.py"]
