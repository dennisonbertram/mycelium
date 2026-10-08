// Live check over the public Waku network: signed identities, a public channel, an encrypted direct
// message, an open addressed message, and channel push for trusted senders.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { z } from "zod";

const home = mkdtempSync(join(tmpdir(), "mycelium-test-"));
const env = (name, extra = {}) => ({ ...process.env, MYCELIUM_HOME: home, AGENT_NAME: name, ...extra });
const run = (args, name) => execFileSync("node", ["server.js", ...args], { env: env(name) }).toString().trim();
const room = run(["keygen"], "x");
const [aliceAddr] = run(["whoami"], "alice").split("\n");
const [bobAddr, bobCard] = run(["whoami"], "bob").split("\n");
assert.equal(run(["whoami"], "alice").split("\n")[0], aliceAddr, "identity persists");

async function agent(name, extra) {
  const c = new Client({ name, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["server.js"], env: env(name, { MYCELIUM_ROOM_KEY: room, ...extra }), stderr: "inherit" }));
  return c;
}
const call = async (c, name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const [a, b] = await Promise.all([agent("alice"), agent("bob", { MYCELIUM_TRUSTED: aliceAddr })]);
const pushed = [];
b.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), (n) => pushed.push(n.params));

const channel = `test-${Date.now()}`;
console.log(await call(a, "join_channel", { channel }));
console.log(await call(b, "join_channel", { channel }));
console.log("alice:", await call(a, "send_message", { channel, text: "hello channel" }));
console.log("alice:", await call(a, "add_contact", { card: bobCard }));
console.log("alice:", await call(a, "send_message", { text: "secret for bob", to: bobAddr }));
console.log("alice:", await call(a, "send_message", { text: "hi bob, openly", to: bobAddr, public: true }));
// A third agent in the same room must not see the encrypted DM, only the open one.
const carol = await agent("carol");
const got = [];
for (let i = 0; i < 20 && got.length < 3; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const out = await call(b, "read_messages");
  if (out !== "No new messages.") got.push(...JSON.parse(out));
}
console.log("bob read:", got);
assert.ok(got.some((m) => m.channel === channel && m.from === aliceAddr && m.trusted && m.text === "hello channel"));
assert.ok(got.some((m) => m.channel === "dm" && m.encrypted && m.from === aliceAddr && m.text === "secret for bob"), "encrypted DM");
assert.ok(got.some((m) => m.channel === "room" && !m.encrypted && m.toYou && m.text === "hi bob, openly"), "open addressed message");
// Bob learned alice's encryption key from her signed message, so he can reply encrypted without exchanging keys.
console.log("bob:", await call(b, "send_message", { text: "secret for alice", to: aliceAddr }));
let aliceGot = [];
for (let i = 0; i < 20 && !aliceGot.some((m) => m.text === "secret for alice"); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const out = await call(a, "read_messages");
  if (out !== "No new messages.") aliceGot.push(...JSON.parse(out));
}
assert.ok(aliceGot.some((m) => m.encrypted && m.from === bobAddr && m.text === "secret for alice"), "encrypted reply");
const carolOut = await call(carol, "read_messages");
console.log("carol read:", carolOut);
assert.ok(!carolOut.includes("secret"), "third party cannot read DMs");
assert.ok(carolOut.includes("hi bob, openly"), "open addressed messages stay visible to the channel");
assert.ok(pushed.some((p) => p.content === "hello channel" && p.meta.from === aliceAddr && p.meta.channel === channel), "trusted push");
console.log("PASS");
process.exit(0);
