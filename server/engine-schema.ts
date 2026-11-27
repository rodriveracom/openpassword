import type { DatabaseSync } from 'node:sqlite'

// The triggers commit the intent even when the originating handler never returns.
export function installEngineSchema(db: DatabaseSync) {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS engine_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS engine_accounting(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,source INTEGER NOT NULL,at INTEGER NOT NULL,state TEXT,input_tokens INTEGER,output_tokens INTEGER,reserved INTEGER,charged INTEGER);
    CREATE TABLE IF NOT EXISTS engine_cursor(id INTEGER PRIMARY KEY CHECK(id=1), visible INTEGER NOT NULL);
    INSERT OR IGNORE INTO engine_cursor SELECT 1,COALESCE(MAX(id),0) FROM events;
    CREATE TABLE IF NOT EXISTS engine_jobs(id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))), kind TEXT NOT NULL, ref TEXT NOT NULL, due INTEGER, ready INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,ref));
    CREATE INDEX IF NOT EXISTS engine_due ON engine_jobs(ready,due);
    CREATE TRIGGER IF NOT EXISTS engine_activity AFTER INSERT ON events BEGIN
      INSERT INTO engine_events(kind,source) VALUES('activity',NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS engine_pair AFTER INSERT ON pairs BEGIN
      INSERT INTO engine_jobs(kind,ref,due) VALUES('pair',NEW.id,NEW.expires); END;
    CREATE TRIGGER IF NOT EXISTS engine_pair_end AFTER DELETE ON pairs BEGIN
      UPDATE engine_jobs SET ready=1 WHERE kind='pair' AND ref=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS engine_host AFTER INSERT ON cli_hosts BEGIN
      INSERT INTO engine_jobs(kind,ref,due) VALUES('host',NEW.id,NEW.expires); END;
    CREATE TRIGGER IF NOT EXISTS engine_host_end AFTER UPDATE OF ticket ON cli_hosts WHEN NEW.ticket IS NULL BEGIN
      UPDATE engine_jobs SET ready=1 WHERE kind='host' AND ref=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS engine_approval AFTER INSERT ON runs WHEN NEW.state='pending' BEGIN
      INSERT INTO engine_jobs(kind,ref) VALUES('approval',NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS engine_decision AFTER UPDATE OF state ON runs WHEN NEW.state!='pending' BEGIN
      UPDATE engine_jobs SET ready=1 WHERE kind='approval' AND ref=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS engine_revoke AFTER UPDATE OF active ON grants WHEN OLD.active=1 AND NEW.active=0 BEGIN
      INSERT OR IGNORE INTO engine_jobs(kind,ref,ready) VALUES('revocation',NEW.id,1); END;
    CREATE TRIGGER IF NOT EXISTS engine_rotation AFTER INSERT ON events WHEN NEW.action='Credential rotated' BEGIN
      INSERT INTO engine_jobs(kind,ref,ready) VALUES('rotation',NEW.id,1); END;
    INSERT OR IGNORE INTO engine_jobs(kind,ref,due) SELECT 'pair',id,expires FROM pairs;
    INSERT OR IGNORE INTO engine_jobs(kind,ref,due) SELECT 'host',id,expires FROM cli_hosts WHERE ticket IS NOT NULL;
    INSERT OR IGNORE INTO engine_jobs(kind,ref) SELECT 'approval',id FROM runs WHERE state='pending';
    COMMIT;`)
  for (const [table, kind] of [
    ['consumption_events', 'usage'],
    ['model_charges', 'meter'],
  ]) {
    const amounts =
      kind === 'usage'
        ? 'NEW.outcome,NEW.input_tokens,NEW.output_tokens,NULL,NULL'
        : 'NEW.state,NULL,NULL,NEW.reserved,NEW.charged'
    for (const op of ['INSERT', 'UPDATE'])
      db.exec(`CREATE TRIGGER IF NOT EXISTS engine_${kind}_${op} AFTER ${op} ON ${table} BEGIN
        INSERT INTO engine_events(kind,source) VALUES('${kind}',NEW.rowid);
        INSERT INTO engine_accounting VALUES(last_insert_rowid(),'${kind}',NEW.rowid,CAST(unixepoch('subsec')*1000 AS INTEGER),${amounts}); END`)
  }
}
