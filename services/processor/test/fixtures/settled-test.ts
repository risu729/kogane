// Run by test/settled-test.test.ts as its own `bun test` process, never discovered
// by the suite: cases declared through `settledTest()`, one of which times out
// while its body runs on and one of which rejects after its timeout. The last
// case prints what the cases after them saw.
import { settledTest } from "../support/settle.ts";

const test = settledTest();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let slowBodyDone = false;
let lateBodyDone = false;
let sawSlowBodyDone: boolean | null = null;
let sawLateBodyDone: boolean | null = null;
let doneArity: number | null = null;
let eachRow: number | null = null;
let concurrentRefused = false;
try {
  test.concurrent("never registered", () => undefined);
} catch {
  concurrentRefused = true;
}

test("times out", async () => {
  await sleep(300);
  slowBodyDone = true;
}, 50);

test("runs after the slow body settled", () => {
  sawSlowBodyDone = slowBodyDone;
});

test("rejects late", async () => {
  await sleep(150);
  lateBodyDone = true;
  throw new Error("synthetic late rejection");
}, 50);

test("runs after the late body settled", () => {
  sawLateBodyDone = lateBodyDone;
});

test("done callback", (done) => {
  doneArity = 1;
  setTimeout(done, 5);
});

test.each([[7]])("each row %i", (row) => {
  eachRow = row;
});

test("reports", () => {
  console.log(
    "SETTLE " +
      JSON.stringify({
        sawSlowBodyDone,
        sawLateBodyDone,
        doneArity,
        eachRow,
        concurrentRefused,
      }),
  );
});
