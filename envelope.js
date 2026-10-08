// Signed message envelope. Every message carries an EIP-191 signature from the sender's Ethereum identity key,
// so "from" is a verified address, not a claim. "name" is an unverified display label. "encKey" is the
// sender's separate encryption public key; signing it binds it to the address so others can encrypt to them.
import { verifyMessage, getAddress, isAddress, SigningKey } from "ethers";

const FIELDS = ["v", "id", "topic", "channel", "from", "encKey", "name", "to", "kind", "text", "sentAt"];
// Fixed field order so signer and verifier hash identical bytes. The Waku topic is signed so a message
// cannot be replayed into a different channel or private room (topics derive from the channel key).
const canonical = (m) => JSON.stringify(FIELDS.map((f) => m[f] ?? null));

export async function sign(wallet, m) {
  return { ...m, v: 1, from: wallet.address, sig: await wallet.signMessage(canonical({ ...m, v: 1, from: wallet.address })) };
}

const str = (x, max) => typeof x === "string" && x.length <= max;

export const MAX_TEXT = 100_000;
// Uncompressed secp256k1 public key that is actually a point on the curve.
export const isPubkey = (k) => {
  try {
    return typeof k === "string" && /^0x04[0-9a-fA-F]{128}$/.test(k) && SigningKey.computePublicKey(k, false).toLowerCase() === k.toLowerCase();
  } catch {
    return false;
  }
};
// Identity key signs this to vouch for an encryption key out of band (whoami / add_contact).
export const contactText = (encKey) => `mycelium contact v1 ${encKey}`;

// Returns the message with normalized addresses if it is well formed and signed by m.from, else null.
export function verify(m, topic) {
  try {
    if (m?.v !== 1 || m.topic !== topic || !str(m.id, 128) || !str(m.channel, 64) || !str(m.text, MAX_TEXT)) return null;
    if (!str(m.sentAt, 64) || !(m.name == null || str(m.name, 64)) || !(m.to == null || (str(m.to, 42) && isAddress(m.to)))) return null;
    if (!(m.encKey == null || isPubkey(m.encKey))) return null;
    if (!(m.kind == null || m.kind === "status")) return null; // "status": what the sender is working on
    if (!str(m.sig, 200) || !isAddress(m.from) || verifyMessage(canonical(m), m.sig) !== getAddress(m.from)) return null;
    return { ...m, from: getAddress(m.from), to: m.to && getAddress(m.to) };
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Wallet } = await import("ethers");
  const assert = (await import("node:assert")).default;
  const alice = Wallet.createRandom();
  const mallory = Wallet.createRandom();
  const enc = Wallet.createRandom().signingKey.publicKey;
  const m = await sign(alice, { id: "1", topic: "t1", channel: "room", encKey: enc, name: "alice", text: "hi", sentAt: "t" });
  assert.equal(verify(m, "t1").encKey, enc);
  assert.ok(!verify({ ...m, encKey: mallory.signingKey.publicKey }, "t1"), "swapped encryption key");
  assert.ok(!verify({ ...m, kind: "status" }, "t1"), "kind is signed");
  assert.ok(!verify(m, "t2"), "replay into another room with the same label");
  assert.ok(!verify({ ...m, text: "pay mallory" }, "t1"), "tampered text");
  assert.ok(!verify({ ...m, to: mallory.address }, "t1"), "tampered recipient");
  const forged = await sign(mallory, { id: "2", topic: "t1", channel: "room", name: "alice", text: "hi", sentAt: "t" });
  assert.ok(!verify({ ...forged, from: alice.address }, "t1"), "forged sender");
  assert.ok(!verify({ ...m, sig: "0x00" }, "t1"), "garbage signature");
  const odd = await sign(mallory, { id: "3", topic: "t1", channel: "room", name: { x: 1 }, to: "nope", text: "hi", sentAt: "t" });
  assert.ok(!verify(odd, "t1"), "signed but malformed fields");
  const lower = { ...m, from: alice.address.toLowerCase() };
  lower.sig = await alice.signMessage(canonical(lower));
  assert.equal(verify(lower, "t1").from, alice.address, "address normalized");
  assert.ok(!isPubkey("0x04" + "0".repeat(128)), "point not on curve");
  assert.ok(isPubkey(enc));
  console.log("envelope: PASS");
}
