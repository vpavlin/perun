// Peer sync-frame guard (perun_json.hpp catchupWellFormed). A SYNC_REQ's msg goes into the
// vendored logos_sync::catchup::respond(), which throws on a wrong-typed field and
// assert-aborts on a missing "bounds" - both used to kill the module. This checks the guard
// rejects those shapes (and that respond() really does fail on them), and accepts every frame
// buildInitial()/respond() actually produce.
// Build & run (from the repo root):
//   g++ -std=c++17 -Icore/src -I<nlohmann>/include core/test/sync_frame_guard.cpp -lcrypto -o /tmp/sfg && /tmp/sfg
#include <cstdio>
#include "perun_json.hpp"
#include "logos_sync/catchup.hpp"
using nlohmann::json;
static int fails = 0, checks = 0;
static void ok(bool c, const char* what) { checks++; if (!c) { fails++; std::printf("  FAIL %s\n", what); } }

int main() {
  auto cu = [](const char* s) { return perun::catchupWellFormed(json::parse(s)); };
  ok(cu(R"({"v":2,"t":"fp","from":"p","bounds":["b"],"fps":["x","y"]})"), "fp ok");
  ok(cu(R"({"v":2,"t":"ids","from":"p","lo":"a","hi":"z","ids":["b"]})"), "ids ok");
  ok(cu(R"({"v":2,"t":"need","from":"p","ids":[]})"), "need ok");
  ok(!cu(R"({"v":2,"t":"fp","from":"p","fps":["x","y"]})"), "fp missing bounds rejected");
  ok(!cu(R"({"v":2,"t":"fp","from":"p","bounds":[],"fps":["x","y"]})"), "fp short bounds rejected");
  ok(!cu(R"({"v":2,"t":"ids","from":"p","ids":[5]})"), "numeric id rejected");
  ok(!cu(R"({"v":2,"t":"need","from":"p"})"), "need without ids rejected");
  ok(!cu(R"({"v":2,"t":"fp","from":5.0,"bounds":[],"fps":["x"]})"), "numeric from rejected");
  ok(!cu(R"({"v":2,"t":["fp"]})"), "non-string t rejected");
  ok(!cu(R"("fp")"), "non-object rejected");

  // The unguarded respond() really throws on what the guard rejects (the crash being fixed).
  std::vector<logos_sync::Event> mine(2); mine[0].id = "a"; mine[1].id = "b";
  bool threw = false;
  try { logos_sync::catchup::respond(mine, json::parse(R"({"v":2,"t":"ids","from":"p","ids":[5]})"), "me"); }
  catch (const json::exception&) { threw = true; }
  ok(threw, "respond() throws on a numeric id (the guarded crash)");

  // Every frame a real reconciliation produces passes.
  std::vector<logos_sync::Event> a, b;
  for (int i = 0; i < 60; i++) { logos_sync::Event e; e.id = "ann" + std::to_string(i * 31 % 97); a.push_back(e); if (i % 4) b.push_back(e); }
  std::vector<json> q{logos_sync::catchup::buildInitial(a, "A")};
  int rounds = 0, rejected = 0;
  while (!q.empty() && rounds++ < 200) {
    json m = q.back(); q.pop_back();
    if (!perun::catchupWellFormed(m)) rejected++;
    auto st = logos_sync::catchup::respond(rounds % 2 ? b : a, m, rounds % 2 ? "B" : "A");
    for (auto& r : st.replies) q.push_back(r);
  }
  ok(rejected == 0, "every real catch-up frame passes");
  std::printf("%s - %d/%d checks passed (%d real frames)\n", fails ? "SYNC FRAME GUARD FAILED" : "SYNC FRAME GUARD OK",
              checks - fails, checks, rounds);
  return fails ? 1 : 0;
}
