import { generateHandshakeKey } from "../src/crypto";

process.stdout.write(JSON.stringify(generateHandshakeKey()));
