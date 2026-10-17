// Base de données SQLite intégrée à Node (node:sqlite), un seul fichier dans DATA_DIR.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const MIGRATIONS = [
  // v1 : schéma initial
  `
  CREATE TABLE users(
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pseudo TEXT NOT NULL,
    pseudo_lc TEXT UNIQUE NOT NULL,
    pass_hash TEXT,
    minor INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    email_verified INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions(
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE tokens(
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE constitution(
    n INTEGER PRIMARY KEY,
    date INTEGER NOT NULL,
    params TEXT NOT NULL,
    free TEXT NOT NULL,
    note TEXT NOT NULL,
    via TEXT
  );
  CREATE TABLE laws(
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    themes TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'vigueur',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE law_versions(
    law_id TEXT NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    date INTEGER NOT NULL,
    text TEXT NOT NULL,
    note TEXT NOT NULL,
    via TEXT,
    abrog INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(law_id, n)
  );
  CREATE TABLE proposals(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    themes TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    is2027 INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL,
    dates TEXT NOT NULL,
    projet_days INTEGER NOT NULL,
    delib_days INTEGER NOT NULL,
    rules TEXT NOT NULL,
    const_v INTEGER NOT NULL,
    target_law TEXT,
    target_base INTEGER,
    const_base TEXT,
    fork_of TEXT,
    law_id TEXT,
    files TEXT NOT NULL DEFAULT '[]',
    links TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX proposals_phase ON proposals(phase);
  CREATE TABLE proposal_versions(
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    date INTEGER NOT NULL,
    note TEXT NOT NULL,
    text TEXT NOT NULL,
    cst TEXT,
    PRIMARY KEY(proposal_id, n)
  );
  CREATE TABLE notes(
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    date INTEGER NOT NULL,
    text TEXT NOT NULL,
    para INTEGER,
    base TEXT,
    proposed TEXT,
    status TEXT,
    reports INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notes_proposal ON notes(proposal_id);
  CREATE TABLE reports(
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date INTEGER NOT NULL,
    PRIMARY KEY(note_id, user_id)
  );
  CREATE TABLE parrainages(
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date INTEGER NOT NULL,
    PRIMARY KEY(proposal_id, user_id)
  );
  CREATE TABLE votes(
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    choice TEXT NOT NULL,
    minor INTEGER NOT NULL,
    date INTEGER NOT NULL,
    PRIMARY KEY(proposal_id, user_id)
  );
  CREATE TABLE journal(
    id INTEGER PRIMARY KEY,
    date INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE uploads(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    date INTEGER NOT NULL
  );
  `,
  // v2 : modération citoyenne (signalements, affaires, jurys, sanctions, notifications)
  `
  ALTER TABLE users ADD COLUMN suspended_until INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE proposals ADD COLUMN under_review INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE flags(
    id INTEGER PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    comment TEXT,
    date INTEGER NOT NULL,
    case_id TEXT,
    UNIQUE(target_type, target_id, user_id)
  );
  CREATE INDEX flags_target ON flags(target_type, target_id, case_id);
  INSERT INTO flags(target_type,target_id,user_id,reason,comment,date,case_id)
    SELECT 'note', note_id, user_id, 'autre', NULL, date, NULL FROM reports;
  CREATE TABLE cases(
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_user INTEGER REFERENCES users(id),
    round INTEGER NOT NULL DEFAULT 1,
    appeal_of TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    snapshot TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    extended INTEGER NOT NULL DEFAULT 0,
    jury_size INTEGER NOT NULL,
    closed_at INTEGER,
    decision TEXT,
    tally TEXT,
    note TEXT,
    appealed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX cases_status ON cases(status);
  CREATE TABLE case_jurors(
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    drawn_at INTEGER NOT NULL,
    vote TEXT,
    comment TEXT,
    voted_at INTEGER,
    PRIMARY KEY(case_id, user_id)
  );
  CREATE TABLE sanctions(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    case_id TEXT,
    kind TEXT NOT NULL,
    until INTEGER,
    date INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE notifications(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date INTEGER NOT NULL,
    text TEXT NOT NULL,
    link TEXT,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notifications_user ON notifications(user_id, read);
  `
];

export function openDb(file) {
  const target = file || path.join(config.dataDir, "mesvotes.db");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}

export const db = openDb(process.env.NODE_ENV === "test" ? ":memory:" : undefined);

const cache = new Map();
/** Requête préparée mise en cache. */
export const q = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };

let depth = 0;
/** Exécute fn dans une transaction (réentrante). */
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  finally { depth--; }
}

export const J = s => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
export const S = v => JSON.stringify(v ?? null);
