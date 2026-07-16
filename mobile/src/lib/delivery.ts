// Native Logos Delivery (embedded Waku node) bridge — the phone runs its OWN
// liblogosdelivery.so node via the LogosMessaging JNI module and publishes runs
// on the Perun content topic, where the desktop Basecamp module receives them.
//
// The native module is arm64-only (no x86_64 build), so on the emulator
// `deliveryAvailable()` is true (the JS module is registered) but `ensureNode()`
// will reject when setup() can't load the .so — callers surface that as an error.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray } from "base64-js";
import { loadIdentity } from "./identityStore";
import { seal, topicFor, Identity } from "./identity";

const { LogosMessaging } = NativeModules as { LogosMessaging: any };

// Every phone/Basecamp pair gets its OWN derived content topic (topicFor(id)),
// so there is no shared, fixed topic anymore — an unpaired phone has nowhere to
// publish and MUST NOT fall back to a public plaintext topic. This constant is
// kept only as documentation of the topic *shape*; live sends use the derived one.
export const PERUN_TOPIC = "/perun/1/<derived-from-pairing-secret>/proto";

// Time to let the freshly-started node dial logos.dev + form the pubsub mesh
// before the first publish. Only paid once, on initial node bring-up.
const SETTLE_MS = 10000;

// logos.dev bootstrap peers — the same set the desktop delivery_module dials.
const BOOTSTRAP = [
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH",
  "/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397",
  "/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
  "/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE",
];

/** True if the native module is present in this build at all. */
export function deliveryAvailable(): boolean {
  return !!LogosMessaging;
}

// UTF-8 encode a string to bytes. Hand-rolled on purpose: no TextEncoder (not
// guaranteed on Hermes) and no escape/unescape (legacy Annex-B globals).
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

// The running node's context handle plus the paired identity + derived topic it
// was brought up for. Bound together so a send always uses the topic we joined.
interface Node { ctx: string; id: Identity; topic: string }
let node: Node | null = null;
let starting: Promise<Node> | null = null;
let emitter: NativeEventEmitter | null = null;

/** Error thrown when a sync is attempted before pairing. Surfaced to the user. */
export const NOT_PAIRED = "Pair with your Basecamp first";

/**
 * Bring the node up once (idempotent): load identity (must be paired) → setup →
 * new(logos.dev) → start → subscribe(derived topic). Concurrent callers share the
 * same in-flight startup. Rejects with NOT_PAIRED if the phone isn't paired.
 */
export async function ensureNode(onStatus?: (s: string) => void): Promise<string> {
  if (!LogosMessaging) throw new Error("Logos Delivery native module not present in this build");
  if (node) return node.ctx;
  if (starting) return (await starting).ctx;
  starting = (async () => {
    const id = await loadIdentity();
    if (!id) throw new Error(NOT_PAIRED);
    const topic = topicFor(id);
    onStatus?.("Starting node…");
    await LogosMessaging.setup();
    const config = { mode: "Core", preset: "logos.dev", relay: true, entryNodes: BOOTSTRAP };
    const c: string = await LogosMessaging.new(config);
    onStatus?.("Connecting to logos.dev…");
    await LogosMessaging.start(c);
    // logosdelivery_subscribe takes the CONTENT topic directly. We subscribe so
    // the phone can also receive (future two-way); publishing does not require it.
    await LogosMessaging.relaySubscribe(c, topic);
    // Give the node time to dial the bootstrap peers and form the pubsub mesh
    // before the first publish — an immediate send can be dropped with no peers.
    onStatus?.("Joining mesh…");
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const n: Node = { ctx: c, id, topic };
    node = n;
    onStatus?.("Connected");
    return n;
  })();
  try {
    return (await starting).ctx;
  } catch (e) {
    node = null;
    throw e;
  } finally {
    starting = null;
  }
}

/**
 * Publish one JSON envelope on the pair's derived topic. The whole envelope-JSON
 * is sealed (ChaCha20-Poly1305, AAD=topic) with the pairing key, then base64'd
 * into the liblogosdelivery send message ({contentTopic, payload, ephemeral}).
 * No pairing → no send: we never publish plaintext on a public topic.
 */
export async function sendEnvelope(env: object): Promise<void> {
  await ensureNode();
  const n = node!;
  const sealed = seal(n.id, utf8Bytes(JSON.stringify(env)), n.topic);
  const messageJson = JSON.stringify({
    contentTopic: n.topic,
    payload: fromByteArray(sealed),
    ephemeral: false,
  });
  await LogosMessaging.send(n.ctx, messageJson);
}

/** Subscribe to incoming Delivery messages (returns an unsubscribe fn). */
export function onMessage(cb: (evt: { wakuPtr: string; event: string }) => void): () => void {
  if (!LogosMessaging) return () => {};
  if (!emitter) emitter = new NativeEventEmitter(LogosMessaging);
  const sub = emitter.addListener("logosMessage", cb);
  return () => sub.remove();
}

/** Stop the node (best-effort). */
export async function stopNode(): Promise<void> {
  if (node && LogosMessaging) {
    const c = node.ctx;
    node = null;
    try {
      await LogosMessaging.stop(c);
    } catch {
      /* ignore */
    }
  }
}
