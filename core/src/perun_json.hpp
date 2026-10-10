// perun_json.hpp - typed checks for JSON that other people wrote (peers' sync frames).
// nlohmann's value()/get<>() throw on a wrong type and const operator[] asserts on a missing
// key; an exception (or abort) in a Basecamp core kills the module.
#pragma once
#include <string>
#include <nlohmann/json.hpp>

namespace perun {
// A peer's RBSR catch-up frame (fp/ids/need), checked BEFORE the vendored
// logos_sync::catchup::respond() sees it. respond() reads these fields with value()/get<>()
// (a wrong type throws) and const operator[] (a MISSING "bounds"/"fps"/"ids" is an assertion
// abort, which no try/catch survives) - either kills the module. Accepts exactly the shape
// buildFp()/respond() emit: optional string from/lo/hi; fp = string arrays fps + bounds with
// bounds.size() >= fps.size() - 1; ids/need = a string array ids. (Fix upstream in logos-sync.)
inline bool catchupWellFormed(const nlohmann::json& m) {
    if (!m.is_object()) return false;
    for (const char* k : {"from", "lo", "hi"}) {
        auto it = m.find(k);
        if (it != m.end() && !it->is_string()) return false;
    }
    auto strArray = [&](const char* k, size_t& n) {
        auto it = m.find(k);
        if (it == m.end() || !it->is_array()) return false;
        for (const auto& x : *it) if (!x.is_string()) return false;
        n = it->size();
        return true;
    };
    auto t = m.find("t");
    if (t == m.end() || !t->is_string()) return false;
    const std::string tt = t->get<std::string>();
    size_t nf = 0, nb = 0;
    if (tt == "fp") return strArray("fps", nf) && strArray("bounds", nb) && (nf == 0 || nb + 1 >= nf);
    if (tt == "ids" || tt == "need") return strArray("ids", nf);
    return true;   // any other t: respond() ignores it
}
} // namespace perun
