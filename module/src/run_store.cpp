#include "run_store.h"

#include <sqlite3.h>

namespace perun {

RunStore::~RunStore() { close(); }

bool RunStore::open(const std::string &path) {
  if (sqlite3_open(path.c_str(), &m_db) != SQLITE_OK) {
    m_db = nullptr;
    return false;
  }
  static const char *kDdl =
      "CREATE TABLE IF NOT EXISTS runs ("
      "  id TEXT PRIMARY KEY,"
      "  startTs INTEGER,"
      "  json TEXT NOT NULL,"
      "  gpx BLOB);";
  char *err = nullptr;
  if (sqlite3_exec(m_db, kDdl, nullptr, nullptr, &err) != SQLITE_OK) {
    if (err) sqlite3_free(err);
    close();
    return false;
  }
  // Migrate older DBs that predate the gpx column (ignore "duplicate column").
  sqlite3_exec(m_db, "ALTER TABLE runs ADD COLUMN gpx BLOB;", nullptr, nullptr,
               nullptr);

  // Journey annotations — one row per annotation (including delete tombstones),
  // keyed by the annotation's own id. Added additively; older run DBs get it on
  // the next open with no run data touched.
  static const char *kAnnDdl =
      "CREATE TABLE IF NOT EXISTS annotations ("
      "  id TEXT PRIMARY KEY,"
      "  runId TEXT,"
      "  t INTEGER,"
      "  json TEXT NOT NULL);";
  sqlite3_exec(m_db, kAnnDdl, nullptr, nullptr, nullptr);
  return true;
}

void RunStore::close() {
  if (m_db) { sqlite3_close(m_db); m_db = nullptr; }
}

bool RunStore::upsert(const std::string &id, int64_t startTs,
                      const std::string &json, const std::string &gpxGz) {
  if (!m_db) return false;
  static const char *kSql =
      "INSERT OR REPLACE INTO runs (id, startTs, json, gpx) VALUES (?, ?, ?, ?);";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return false;
  sqlite3_bind_text(st, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 2, static_cast<sqlite3_int64>(startTs));
  sqlite3_bind_text(st, 3, json.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_blob(st, 4, gpxGz.data(), static_cast<int>(gpxGz.size()),
                    SQLITE_TRANSIENT);
  const bool done = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return done;
}

std::vector<std::string> RunStore::loadAll() const {
  std::vector<std::string> out;
  if (!m_db) return out;
  static const char *kSql = "SELECT json FROM runs ORDER BY startTs DESC;";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return out;
  while (sqlite3_step(st) == SQLITE_ROW) {
    const unsigned char *t = sqlite3_column_text(st, 0);
    if (t) out.emplace_back(reinterpret_cast<const char *>(t));
  }
  sqlite3_finalize(st);
  return out;
}

std::string RunStore::getGpx(const std::string &id) const {
  std::string out;
  if (!m_db) return out;
  static const char *kSql = "SELECT gpx FROM runs WHERE id = ?;";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return out;
  sqlite3_bind_text(st, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  if (sqlite3_step(st) == SQLITE_ROW) {
    const void *blob = sqlite3_column_blob(st, 0);
    const int n = sqlite3_column_bytes(st, 0);
    if (blob && n > 0) out.assign(static_cast<const char *>(blob), n);
  }
  sqlite3_finalize(st);
  return out;
}

bool RunStore::upsertAnnotation(const std::string &id, const std::string &runId,
                                int64_t t, const std::string &json) {
  if (!m_db) return false;
  static const char *kSql =
      "INSERT OR REPLACE INTO annotations (id, runId, t, json) "
      "VALUES (?, ?, ?, ?);";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return false;
  sqlite3_bind_text(st, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, runId.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 3, static_cast<sqlite3_int64>(t));
  sqlite3_bind_text(st, 4, json.c_str(), -1, SQLITE_TRANSIENT);
  const bool done = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return done;
}

std::vector<std::string> RunStore::loadAnnotations() const {
  std::vector<std::string> out;
  if (!m_db) return out;
  static const char *kSql = "SELECT json FROM annotations ORDER BY t ASC;";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return out;
  while (sqlite3_step(st) == SQLITE_ROW) {
    const unsigned char *t = sqlite3_column_text(st, 0);
    if (t) out.emplace_back(reinterpret_cast<const char *>(t));
  }
  sqlite3_finalize(st);
  return out;
}

} // namespace perun
