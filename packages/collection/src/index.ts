// @kogane/collection: the shared DATA-bucket contract — key layout, the
// `terminal-v1` manifest, its canonical encoding and digest, the
// terminal-last writer, the reader/verifier, and the stage vocabulary.
//
// Pure TypeScript over a minimal `R2BucketLike`: no Cloudflare `Env`, no D1,
// no HTTP, no credentials. Collectors and the Processor share it, so both
// sides of "the terminal is the completion record" are one implementation.
export * from "./bucket";
export * from "./keys";
export * from "./manifest";
export * from "./digest";
export * from "./verify";
export * from "./writer";
export * from "./reader";
export * from "./stages";
