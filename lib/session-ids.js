// Call inside the session-creation transaction. Deleted IDs must never be
// reused by a stale extension binding, history link, or confirmation button.
function nextSessionId(db) {
  return db.prepare(`INSERT INTO id_sequences (name, value)
    VALUES ('sessions', COALESCE((SELECT MAX(id) FROM sessions), 0) + 1)
    ON CONFLICT(name) DO UPDATE SET value = MAX(value, COALESCE((SELECT MAX(id) FROM sessions), 0)) + 1
    RETURNING value`).get().value;
}

module.exports = { nextSessionId };
