// Dev helper: drive the running app over the Chrome DevTools protocol.
// Start the app with `npx electron . --remote-debugging-port=9223`, then:
//   node tools/cdp.mjs eval "<js expression>"
//   node tools/cdp.mjs shot out.png
import fs from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const my = ++id;
  ws.addEventListener("message", function on(ev) {
    const msg = JSON.parse(ev.data);
    if (msg.id === my) { ws.removeEventListener("message", on); resolve(msg.result); }
  });
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 1));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log("saved", arg);
}
ws.close();
