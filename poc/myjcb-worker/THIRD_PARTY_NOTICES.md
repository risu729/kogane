# Third-party research notice

This PoC is an independent implementation. It does not contain source code,
fixtures, protection-runtime code, or derived source files from `mnie` or
`youseiushida/Okura`.

The public AGPL-3.0 Okura implementation was inspected only to corroborate the
current public MyJCB origin, login/mypage paths, debit menu/detail paths, the
`seq=0..14` observation, the need to keep the User-Agent and cookies together,
and the fact that MyJCB's official login-protection JavaScript must run before
the protected form is submitted. Those protocol observations are documented in
`docs/sources/myjcb.md` with links and a commit identifier. Kogane's code uses
Cloudflare Browser Run to execute the official script in its original page and
was written independently.

Synthetic fixtures in `test/fixtures` contain no copied HTML or real account
data.
