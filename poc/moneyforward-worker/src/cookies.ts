interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  revision: number;
}

export class CookieJar {
  readonly #cookies = new Map<string, Cookie>();

  absorb(responseUrl: URL, response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
    for (const value of values) this.#absorbOne(responseUrl, value);
  }

  header(requestUrl: URL): string {
    const host = requestUrl.hostname.toLowerCase();
    const path = requestUrl.pathname || "/";
    return [...this.#cookies.values()]
      .filter((cookie) => {
        const domainMatches = cookie.hostOnly
          ? host === cookie.domain
          : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
        const pathMatches =
          path === cookie.path ||
          path.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`);
        return domainMatches && pathMatches && (!cookie.secure || requestUrl.protocol === "https:");
      })
      .sort((left, right) => right.path.length - left.path.length)
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }

  safeSummary(): string {
    return [...this.#cookies.values()]
      .map(({ name, domain, path, revision }) => `${domain}${path}:${name}#${revision}`)
      .sort()
      .join(",");
  }

  #absorbOne(responseUrl: URL, value: string): void {
    const parts = value.split(";").map((part) => part.trim());
    const pair = parts.shift();
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) return;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    let domain = responseUrl.hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultPath(responseUrl.pathname);
    let secure = false;
    let remove = cookieValue.length === 0;
    for (const part of parts) {
      const [rawName, ...rawValue] = part.split("=");
      const attribute = rawName?.toLowerCase();
      const attributeValue = rawValue.join("=");
      if (attribute === "domain" && attributeValue) {
        domain = attributeValue.toLowerCase().replace(/^\./u, "");
        hostOnly = false;
      } else if (attribute === "path" && attributeValue.startsWith("/")) {
        path = attributeValue;
      } else if (attribute === "secure") {
        secure = true;
      } else if (attribute === "max-age" && Number(attributeValue) <= 0) {
        remove = true;
      } else if (attribute === "expires" && Date.parse(attributeValue) <= Date.now()) {
        remove = true;
      }
    }
    if (!(responseUrl.hostname === domain || responseUrl.hostname.endsWith(`.${domain}`))) return;
    const key = `${domain}\u0000${path}\u0000${name}`;
    if (remove) this.#cookies.delete(key);
    else {
      const previous = this.#cookies.get(key);
      const revision = previous?.value === cookieValue ? previous.revision : (previous?.revision ?? 0) + 1;
      this.#cookies.set(key, {
        name,
        value: cookieValue,
        domain,
        path,
        hostOnly,
        secure,
        revision,
      });
    }
  }
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=[^;,=]+=[^;,]+)/u);
}
