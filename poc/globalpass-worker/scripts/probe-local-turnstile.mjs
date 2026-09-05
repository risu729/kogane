const port = Number(process.argv[2] || 9222);
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

const expression = `(() => {
  const response = document.querySelector('input[name="cf-turnstile-response"]');
  const widget = document.querySelector('.cf-turnstile');
  return {
    title: document.title,
    tokenLength: String(response?.value || '').length,
    widgetPresent: Boolean(widget),
    widgetRect: widget ? {
      width: widget.getBoundingClientRect().width,
      height: widget.getBoundingClientRect().height
    } : null,
    loginFormVisible: Boolean(document.querySelector('#usrId')),
    accessDenied: /Access Denied|アクセスが拒否/i.test(document.body?.innerText || ''),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver
  };
})()`;

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP response timeout")), 10_000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    }),
  );
});

socket.close();
console.log(JSON.stringify(result.result.result.value, null, 2));
