// Compatibility re-export. src/parsers/sony-bank.ts moved to packages/parsers (design review D07,
// docs/package-layout.md); the PoC entry points and their tests keep the old
// import path, production services import the package directly. No behaviour
// of its own: adding one would split the module in two.
export * from "../../../../packages/parsers/src/parsers/sony-bank.ts";
