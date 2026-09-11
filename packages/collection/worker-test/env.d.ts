// The Miniflare bindings this suite runs with. Declared by hand rather than
// generated with `wrangler types`: this package is not a Worker and its CI
// check is `tsc --noEmit` with no Workers tooling. The binding is typed as the
// package's own `R2BucketLike`, and the suite proves at runtime that the real
// R2 binding satisfies it by driving the whole contract through it.
declare namespace Cloudflare {
  interface Env {
    DATA: import("../src/bucket").R2BucketLike;
  }
}
