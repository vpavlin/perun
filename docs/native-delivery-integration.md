# Native Logos Delivery integration (phone → Basecamp module)

Research from the `receiver-android` reference + `logos-delivery` source. This is the
plan for getting an embedded Waku/Logos Delivery node running inside the Perun mobile
app so the phone can publish recorded runs on `/perun/1/<owner>/proto` and the desktop
Basecamp `perun_analytics` module receives them.

## Bottom line
Achievable, with a working reference (`github.com/xAlisher/receiver-android` — bare RN
0.86, embeds a Logos Delivery node on arm64 over cluster 2). Three hard parts, worst first:

1. **You must cross-compile `liblogosdelivery.so` yourself.** No public prebuilt exists;
   the source org (`logos-messaging/logos-delivery`) is 2FA-gated so the API returns 403.
   The build hit ~16 documented walls (runbook: `docs/logos-messaging-android-build.md`
   in the reference repo).
2. **x86_64 (our emulator) is UNPROVEN.** The Makefile target
   `liblogosdelivery-android-amd64` exists but nobody has shipped it. Only **arm64-v8a**
   binaries exist, and they're committed in receiver-android → directly reusable.
3. **receiver-android is receive-only and bare RN, not Expo.** We add the send path and
   re-express the `android/` JNI edits as an Expo config plugin.

## Emulator caveat (important for us)
The crib emulator is **x86_64**. An arm64 `.so` will **not** load there
(`UnsatisfiedLinkError`). Options:
- Build the x86_64 `.so` (`make liblogosdelivery-android-amd64` + x86_64 `librln.so` +
  x86_64 JNI bridge) — target exists, unproven, biggest time sink.
- **Validate on a real arm64 phone** reusing the committed arm64 binaries — the reliable
  path; exactly how the reference proved a cluster-2 round trip.
- ARM-translation on x86_64 emulators does NOT reliably cover a 28 MB threaded Nim `.so`.

**Decision: keep the native module OFF the emulator critical path.** Do all UI/JS in the
emulator with Delivery stubbed; validate real publish→desktop-receive on a physical arm64
device.

## The reference's 4 layers (the model to copy)
Repo `xAlisher/receiver-android`, classic bridge (NOT a TurboModule → works fine under Expo).
- **(a) `.so`s committed to git** under `android/app/src/main/jniLibs/arm64-v8a/`:
  `liblogosdelivery.so` (28.8 MB Nim node), `librln.so` (6.4 MB zerokit RLN),
  `libc++_shared.so` (1.8 MB NDK C++ rt), `liblogos_messaging_jni.so` (17 KB JNI bridge).
  Reusable arm64 URLs: `raw.githubusercontent.com/xAlisher/receiver-android/main/android/app/src/main/jniLibs/arm64-v8a/<name>.so`
- **(b) JNI bridge (C):** `jni/logos_messaging_ffi.c`. `JNI_OnLoad` caches `JavaVM*` +
  global ref + method ID. The node fires the FFI callback from its own non-JVM threads →
  `AttachCurrentThread` (outside any `assert()` — release strips it), attach-once-per-thread
  via `pthread_key` detach destructor, then `CallStaticVoidMethod`. `wakuSetup()` dup2's
  stdout/stderr into a pipe → `__android_log` (tag `logos-node`) so chronicles logs hit logcat.
- **(c) Kotlin module:** loads libs in strict order `c++_shared → rln → logosdelivery →
  logos_messaging_jni`; `@ReactMethod`s resolve Promises; node pointer passed to JS as a
  **decimal string** of the Long; emits JS event `logosMessage` = `{ wakuPtr, event }`.
- **(d) JS driver:** `setup()` → `new({mode:'Core', preset:'logos.dev', relay:true,
  entryNodes:[...6 delivery-0x bootstraps]})` → `start(ctx)` → `relaySubscribe(ctx,
  contentTopic)`; messages arrive via `NativeEventEmitter('logosMessage')`, payload is a
  UTF-8 **byte array** → bytes→string→JSON.parse. Subscribe by **content topic**, not pubsub.

## FFI / C API (from committed `liblogosdelivery.h`)
```c
typedef void (*FFICallBack)(int callerRet, const char *msg, size_t len, void *userData);
void *logosdelivery_create_node(const char *configJson, FFICallBack cb, void *ud);
int   logosdelivery_start_node (void *ctx, FFICallBack cb, void *ud);
int   logosdelivery_stop_node  (void *ctx, FFICallBack cb, void *ud);
int   logosdelivery_subscribe  (void *ctx, FFICallBack cb, void *ud, const char *contentTopic);
int   logosdelivery_send       (void *ctx, FFICallBack cb, void *ud, const char *messageJson);
//   messageJson = { "contentTopic":"/perun/1/<owner>/proto", "payload":"<base64>", "ephemeral":false }
```
`logosdelivery_send` is the one receiver-android does NOT wire (it's receive-only) — we add
it, mirroring the existing `wakuRelayPublish` JNI+Kotlin path. It's content-topic + base64,
which matches our `/perun/1/<owner>/proto` + gzipped-GPX-chunk model directly. There's also
a Reliable Channels API (`logosdelivery_channel_*`, SDS-backed) worth considering for
reliable chunked delivery.

## Expo prebuild wiring (Route A, recommended)
1. `npx create-expo-module@latest --local modules/delivery` → autolinked Kotlin module.
2. Config plugin `plugins/withLogosDelivery.js`: `withDangerousMod('android')` copies the
   `.so`s into the generated `app/src/main/jniLibs/<abi>/` at prebuild time (never hand-edit
   `android/` — CNG wipes it); `withAppBuildGradle` adds
   `packagingOptions { jniLibs { useLegacyPackaging = true } }` + `ndk { abiFilters }`.
   Register in app.json `plugins`. Survives `expo prebuild --clean`.
3. **JNI bridge `.c` → `.so`:** RN New-Arch already claims the app CMake path (`[CXX1400]`),
   so you can't use `externalNativeBuild` for the bridge — prebuild `liblogos_messaging_jni.so`
   out-of-band with `ndk-build` (Android.mk/Application.mk) per ABI and let the plugin copy it.

## Suggested phasing
- **Phase 0 (spike):** pull committed arm64 `.so`s + Kotlin/JNI/.mk from receiver-android;
  reproduce *receive* on an arm64 phone in a throwaway bare-RN app.
- **Phase 1:** add `logosdelivery_send` (JNI+Kotlin+JS); publish a gzipped-GPX chunk on
  `/perun/1/<owner>/proto`; confirm the desktop module receives it. **Milestone: interop proven.**
- **Phase 2:** re-express as Expo local module + `withLogosDelivery` plugin; verify
  `expo prebuild --clean` survives.
- **Phase 3 (optional/risky):** cross-compile the x86_64 `.so` for in-emulator testing.

## Risk table (worst first)
1. x86_64 `.so` unproven → test on real arm64 phone; reuse committed arm64 binaries.
2. Node-internal threading/FFI SIGSEGVs → reference needed 2 upstream source fork patches
   (`ffi_context.nim` empty-event guard; `node_api.nim` conn-status listener no-op) + JNI
   attach-hardening. Reusing the committed arm64 `.so` bakes these in.
3. `.so` needs C++ runtime → add `--passL:-lc++_shared` at nim link (NOT `patchelf
   --add-needed`, which corrupts GNU_HASH).
4. Build reproducibility → follow `docs/logos-messaging-android-build.md` verbatim.
5. Send path is net-new (mechanical).
6. Expo prebuild vs native edits → config plugin + ndk-build the bridge.
7. APK size: `liblogosdelivery.so` is 28 MB stripped/ABI → ship arm64 to prod, x86_64
   debug-only via ABI splits.

## Key URLs
- `github.com/xAlisher/receiver-android` — `jni/logos_messaging_ffi.c`,
  `LogosMessagingModule.kt`, `jni/liblogosdelivery.h`, `src/discovery/nativeLogosSource.ts`,
  `docs/logos-messaging-android-build.md`, `jniLibs/arm64-v8a/*.so`, `jni/{Android,Application}.mk`.
- `github.com/logos-messaging/logos-delivery` — `Makefile` (android targets ~L545–577,
  incl. `liblogosdelivery-android-amd64`), `logos_delivery.nimble`
  (`libLogosDeliveryAndroid`), `scripts/build_rln_android.sh`, `examples/mobile/`.
  Org enforces 2FA → browse anonymously / raw.githubusercontent.com; authenticated API 403s.
</content>
</invoke>
