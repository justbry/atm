import type { Database } from "bun:sqlite";
import type { SqlDatabase, SqlValue } from "./types.js";

/**
 * The database the handler runs on is a `SqlDatabase` (declared in `types.ts` with the other public types): four
 * synchronous methods that any embedded SQLite driver can satisfy. The core imports no driver.
 *
 *   bun:sqlite      `bunSqlite(db)` in `bun-sqlite.ts`.
 *   node:sqlite     const sqlDatabase = (db: DatabaseSync): SqlDatabase => ({
 *                     exec: (sql) => { db.exec(sql); },
 *                     all: (sql, params = []) => db.prepare(sql).all(...params) as never,
 *                     run: (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
 *                     transaction: (fn) => {
 *                       db.exec("BEGIN IMMEDIATE");
 *                       try { const result = fn(); db.exec("COMMIT"); return result; }
 *                       catch (error) { db.exec("ROLLBACK"); throw error; }
 *                     },
 *                   });
 *   better-sqlite3  the same four lines, except `transaction: (fn) => db.transaction(fn).immediate()`.
 *
 * `transaction` is not re-entrant here: the handler never nests one.
 */

/** A `bun:sqlite` database as a `SqlDatabase`. The only file in the handler that knows about bun:sqlite. */
export const bunSqlite = (db: Database): SqlDatabase => ({
	exec: (sql) => {
		db.exec(sql);
	},
	all: <T>(sql: string, params: readonly SqlValue[] = []) =>
		db.query(sql).all(...params) as T[],
	run: (sql, params = []) => {
		const { changes } = db.query(sql).run(...params);
		return { changes };
	},
	// IMMEDIATE takes the write lock at BEGIN: the handler reads a revision and then writes, and must not be overtaken.
	transaction: (fn) => db.transaction(fn).immediate(),
});
