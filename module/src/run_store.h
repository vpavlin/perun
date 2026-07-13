#pragma once
//
// Tiny SQLite-backed run store — the module's own local persistence (no
// dependency on the outdated kv_module). Runs are kept as their computed JSON
// (id/name/startTs + summary + splits), keyed by id, ordered by start time.
//
#include <cstdint>
#include <string>
#include <vector>

struct sqlite3; // fwd — keep sqlite3.h out of the header

namespace perun {

class RunStore {
public:
  ~RunStore();

  // Open (creating) the DB at `path` and ensure the schema. false on failure.
  bool open(const std::string &path);
  void close();
  bool ok() const { return m_db != nullptr; }

  // Insert-or-replace one run (json = the full computed run object).
  bool upsert(const std::string &id, int64_t startTs, const std::string &json);

  // All runs' JSON, newest (largest startTs) first.
  std::vector<std::string> loadAll() const;

private:
  sqlite3 *m_db = nullptr;
};

} // namespace perun
