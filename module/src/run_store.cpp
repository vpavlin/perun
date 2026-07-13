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
      "  json TEXT NOT NULL);";
  char *err = nullptr;
  if (sqlite3_exec(m_db, kDdl, nullptr, nullptr, &err) != SQLITE_OK) {
    if (err) sqlite3_free(err);
    close();
    return false;
  }
  return true;
}

void RunStore::close() {
  if (m_db) { sqlite3_close(m_db); m_db = nullptr; }
}

bool RunStore::upsert(const std::string &id, int64_t startTs,
                      const std::string &json) {
  if (!m_db) return false;
  static const char *kSql =
      "INSERT OR REPLACE INTO runs (id, startTs, json) VALUES (?, ?, ?);";
  sqlite3_stmt *st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK)
    return false;
  sqlite3_bind_text(st, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 2, static_cast<sqlite3_int64>(startTs));
  sqlite3_bind_text(st, 3, json.c_str(), -1, SQLITE_TRANSIENT);
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

} // namespace perun
