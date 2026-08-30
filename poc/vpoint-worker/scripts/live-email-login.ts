import { createInterface } from "node:readline/promises";
import { beginVPointEmailLogin } from "../src/auth";

const input = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

try {
  const memberNumber = await input.question("VPOINT_MEMBER_NUMBER_REQUIRED\n");
  const challenge = await beginVPointEmailLogin({
    memberNumber,
    onTrace(trace) {
      console.error(JSON.stringify({ event: "VPOINT_LOGIN_TRACE", ...trace }));
    },
  });
  console.log(JSON.stringify({
    event: "VPOINT_EMAIL_CODE_REQUIRED",
    requestedAt: challenge.requestedAt,
  }));
  const code = await input.question("");
  const result = await challenge.complete(code);
  console.log(JSON.stringify({
    event: "VPOINT_EMAIL_LOGIN_SUCCEEDED",
    applicationStatus: result.applicationStatus,
  }));
} finally {
  input.close();
}
