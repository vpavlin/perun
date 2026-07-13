#pragma once
//
// SQLite-backed run store — the module's own local persistence. Each run is
// kept as its computed JSON (id/name/startTs + summary + splits) plus the
// gzipped GPX bytes (source of truth for the map + export), keyed by id.
//
#include <cstdint>
#include <string>
#include <vector>

struct sqlite3; // fwd — keep sqlite3.h out of the header

namespace perun {

class RunStore {
public:
  ~RunStore();

  bool open(const std::string &path);
  void close();
  bool ok() const { return m_db != nullptr; }

  // Insert-or-replace one run. json = computed run object; gpxGz = gzipped GPX.
  bool upsert(const std::string &id, int64_t startTs, const std::string &json,
              const std::string &gpxGz);

  // All runs' JSON, newest (largest startTs) first.
  std::vector<std::string> loadAll() const;

  // Gzipped GPX bytes for one run (empty if unknown).
  std::string getGpx(const std::string &id) const;

private:
  sqlite3 *m_db = nullptr;
};

} // namespace perun
