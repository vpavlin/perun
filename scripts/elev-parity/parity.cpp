#include "run_analytics.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
// minimal JSON array-of-objects reader for this test's own output
int main() {
  std::ifstream f("/tmp/claude-1000/track.json"); std::stringstream ss; ss << f.rdbuf(); std::string s = ss.str();
  perun::Track tr; tr.hasAlt = true;
  size_t i = 0;
  while ((i = s.find('{', i)) != std::string::npos) {
    size_t j = s.find('}', i); std::string o = s.substr(i, j - i);
    auto num = [&](const char* k, double& out) { size_t p = o.find(std::string("\"") + k + "\":"); if (p == std::string::npos) return false; out = std::stod(o.substr(p + strlen(k) + 3)); return true; };
    perun::GeoPoint g; double v;
    num("lat", g.lat); num("lon", g.lon); if (num("t", v)) g.t = (int64_t)v;
    if (num("alt", v)) { g.alt = v; g.altValid = true; }
    g.brk = o.find("\"brk\":true") != std::string::npos;
    tr.points.push_back(g); i = j;
  }
  auto s1 = perun::computeSummary(tr); auto sp = perun::computeSplits(tr, 1000.0);
  printf("C++ gain %.4f splits ", s1.elevGainM);
  for (size_t k = 0; k < sp.size(); ++k) printf("%s%.4f", k ? "," : "", sp[k].elevGainM);
  printf("\n");
}
