import { createInterface } from "node:readline/promises";

const port = Number(process.argv[2] || 9222);
const input = createInterface({ input: process.stdin, output: process.stderr });
const credentialLine = await input.question("");
input.close();
const credentials = JSON.parse(credentialLine);
if (!credentials.username || !credentials.password) {
  throw new Error("username and password are required on stdin as JSON");
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
  response.json(),
);
const page = targets.find(
  (target) => target.type === "page" && target.url.includes("www.debit.vpass.ne.jp/p/login/"),
);
if (!page) throw new Error("GLOBAL PASS login target not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const requests = new Map();
const responses = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Network.requestWillBeSent") {
    requests.set(message.params.requestId, {
      method: message.params.request.method,
      url: message.params.request.url,
    });
  }
  if (message.method === "Network.responseReceived") {
    const request = requests.get(message.params.requestId);
    if (request) responses.push({ ...request, status: message.params.response.status });
  }
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("page evaluation failed");
  return result.result.value;
}

await call("Network.enable");
const before = await evaluate(`(() => ({
  tokenLength: String(document.querySelector('input[name="cf-turnstile-response"]')?.value || '').length,
  loginFormVisible: Boolean(document.querySelector('#usrId')),
  accessDenied: /Access Denied|アクセスが拒否/i.test(document.body?.innerText || '')
}))()`);
if (!before.loginFormVisible || before.accessDenied || before.tokenLength < 20) {
  throw new Error(`precondition failed: ${JSON.stringify(before)}`);
}

await evaluate(`document.querySelector('#usrId').focus()`);
await call("Input.insertText", { text: credentials.username });
await evaluate(`document.querySelector('#password').focus()`);
await call("Input.insertText", { text: credentials.password });
const filled = await evaluate(`(() => ({
  usernameLength: String(document.querySelector('#usrId')?.value || '').length,
  passwordLength: String(document.querySelector('#password')?.value || '').length
}))()`);
if (!filled.usernameLength || !filled.passwordLength) {
  throw new Error("credential fields were not filled");
}

const clicked = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll(
    'button[name="nablarch_form1_2"],button[name="nablarch_form1_5"]'
  )];
  const button = buttons.find((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      rect.width > 0 && rect.height > 0;
  });
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!clicked) throw new Error("visible sign-on button not found");

await new Promise((resolve) => setTimeout(resolve, 12_000));
const result = await evaluate(`(() => {
  const text = document.body?.innerText || '';
  return {
    url: location.href,
    title: document.title,
    loginFormVisible: Boolean(document.querySelector('#usrId')),
    accessDenied: /Access Denied|アクセスが拒否/i.test(text),
    hasActivity: /ご利用明細|利用明細|Usage Details|Transaction/i.test(text),
    hasLogout: /ログアウト|Sign Out|Logout/i.test(text),
    turnstileError: /turnstile|ロボット|認証.*失敗/i.test(text),
    credentialError: /ユーザーID|パスワード|User ID|Password/i.test(text) &&
      /誤|incorrect|invalid|blocked/i.test(text)
  };
})()`);

const network = responses
  .filter(({ url }) => new URL(url).hostname === "www.debit.vpass.ne.jp")
  .map(({ method, url, status }) => {
    const path = new URL(url).pathname.replace(/;jsessionid=[^/;?]+/gi, ";jsessionid=<redacted>");
    return { method, path, status };
  });

socket.close();
console.log(JSON.stringify({ before, filled, result, network }, null, 2));
