# Third-party research notice

This PoC is an independent implementation. It does not contain source code,
fixtures, protection-runtime code, or derived source files from `mnie` or
`youseiushida/Okura`.

The public AGPL-3.0 Okura implementation was inspected only to corroborate the
current public MyJCB origin, login/mypage paths, debit menu/detail paths, the
`seq=0..14` observation, the need to keep the User-Agent and cookies together,
and the fact that MyJCB's official login-protection JavaScript must run before
the protected form is submitted. Historical source research used commit
`afc6057fba78b5bfd6364654548fbfd91c76692a`; the PoC implementation review used
commit `bbf11e032aba4a380009508e91954361a3f9d658`. Those protocol observations are
documented in `docs/sources/myjcb.md`. Kogane's code uses Cloudflare Browser Run
to execute the official script in its original page and was written
independently.

Okura's authenticated-session validator requires both a logout control and the
debit navigation marker `toNaviDebitDetailMenu`, so a credit-only valid session
can be rejected by that validator. Its protection sandbox also uses `node:vm`.
Cloudflare documents `node:vm` as a non-functional stub in the plain Workers
runtime: https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules
This PoC therefore uses Browser Run for official-page JavaScript execution and
does not copy Okura's runtime.

The PoC uses `parse5` 8.0.1 under the MIT License to parse HTML into a generic
tree. No MyJCB- or Okura-specific parser code is provided by `parse5`.

Synthetic fixtures in `test/fixtures` contain no copied HTML or real account
data.
