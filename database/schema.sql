-- Additive schema: existing accounts and classes are preserved.
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(code) = 6),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS classes_teacher_id ON classes(teacher_id);

CREATE TABLE IF NOT EXISTS login_sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_sessions_expiration ON login_sessions(expires_at);

-- Keep session IDs monotonic even when the highest historical session is deleted.
CREATE TABLE IF NOT EXISTS id_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK(value >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live', 'ended', 'interrupted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  checkpoint_at INTEGER NOT NULL,
  CHECK((status = 'live' AND ended_at IS NULL) OR (status != 'live' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_per_class ON sessions(class_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS sessions_class_id ON sessions(class_id);

CREATE TABLE IF NOT EXISTS session_students (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  joined_at INTEGER NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0, 1)),
  grace_started_at INTEGER,
  measurement_started_at INTEGER,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  total_ms INTEGER NOT NULL DEFAULT 0 CHECK(total_ms >= active_ms),
  updated_at INTEGER NOT NULL,
  final_rate REAL CHECK(final_rate BETWEEN 0 AND 100),
  PRIMARY KEY (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS session_students_student_id ON session_students(student_id);

-- Meet measurements are separate so historical website counters never change meaning.
CREATE TABLE IF NOT EXISTS meet_students (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  enrolled_at INTEGER NOT NULL,
  joined_at INTEGER,
  grace_started_at INTEGER,
  measurement_started_at INTEGER,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  total_ms INTEGER NOT NULL DEFAULT 0 CHECK(total_ms >= active_ms),
  unknown_ms INTEGER NOT NULL DEFAULT 0 CHECK(unknown_ms >= 0),
  updated_at INTEGER NOT NULL,
  final_rate REAL CHECK(final_rate BETWEEN 0 AND 100),
  PRIMARY KEY (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS meet_students_student ON meet_students(student_id);
CREATE TABLE IF NOT EXISTS meet_sources (
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 16 AND 80),
  state TEXT NOT NULL CHECK(state IN ('in', 'out', 'unknown')),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, student_id, source_id),
  FOREIGN KEY (session_id, student_id) REFERENCES meet_students(session_id, student_id) ON DELETE RESTRICT
);
