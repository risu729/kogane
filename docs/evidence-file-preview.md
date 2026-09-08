# Evidence file preview and download names

The file detail in acquisition history has an explicit **内容を表示** control.
Opening the detail alone does not request the original. Opening the preview reads
the authenticated attachment endpoint into memory, verifies byte size and SHA-256,
and displays the content without saving a file to Downloads.

JSON and HTML/XML are highlighted with [Shiki](https://shiki.style/guide/bundles)
using its JavaScript engine and only the JSON/XML grammars. HTML markup is shown
as code, never rendered or executed. The renderer preserves original tokens,
large JSON numbers, whitespace and line endings; it does not parse and reserialize
financial JSON. CSV and other declared text formats use plain text. The declared
charset is honored, with UTF-8 as the default. Undecodable/binary data is rejected.

Previews are limited to 512 KiB, enforced before and during the request. Files
above 100 KiB or 10,000 lines use plain text to bound highlighting work. Unsupported
formats and larger files keep their download action and explain the limitation.
Closing/navigating away aborts active reads and removes preview data from the query
cache. Refresh and authentication failures follow the existing evidence query policy.

Download bytes and attachment protection are unchanged. Names preserve the final
component of the collector artifact key, including its extension. Missing extensions
are derived from declared media types when known; unknown formats do not receive a
made-up `.bin` suffix. Unicode names use `filename*`, with an ASCII fallback. Unsafe
path/control characters and reserved filenames are sanitized. Empty names fall back
to a hash-based identifier. Hash-only demo downloads use the hash and media extension.

Browser tests cover on-demand fetching, actual CSP, source text escaping, syntax
coloring, exact large numbers, closing/reopening, and authentication-cache clearing.
Transport tests cover mismatched originals, size limits, character sets and redirects.
