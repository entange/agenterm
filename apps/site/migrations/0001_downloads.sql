-- One row per download from the site. Nothing that identifies a person.
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  version TEXT NOT NULL,
  arch TEXT NOT NULL,
  country TEXT
);

CREATE INDEX downloads_at ON downloads (at);
