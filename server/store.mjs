import pg from "pg";
import { randomUUID } from "node:crypto";
import { createRun } from "../web/engine.mjs";

// Baseline correctness implementation: one transaction serializes a whole run.
// This intentionally trades throughput for simple, restart-safe invariants.
export class Store {
  constructor(url) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 20,
      connectionTimeoutMillis: 60000,
      statement_timeout: 10000,
    });
  }
  async init() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS test_runs (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS active_run (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), run_id text NOT NULL REFERENCES test_runs(id));`);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(7262026)");
      if (!(await c.query("SELECT * FROM active_run")).rowCount) {
        const now = Date.now(),
          id = randomUUID();
        await c.query("INSERT INTO test_runs(id,state) VALUES($1,$2)", [
          id,
          createRun(id, now),
        ]);
        await c.query("INSERT INTO active_run(run_id) VALUES($1)", [id]);
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async transaction(fn) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      // All servers and reset operations take the identical lock first.
      const current = (
        await c.query(
          "SELECT run_id FROM active_run WHERE singleton=true FOR UPDATE",
        )
      ).rows[0].run_id;
      const state = (
        await c.query("SELECT state FROM test_runs WHERE id=$1 FOR UPDATE", [
          current,
        ])
      ).rows[0].state;
      const now = Number(
        (
          await c.query(
            "SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000 AS now",
          )
        ).rows[0].now,
      );
      const result = await fn(state, now);
      await c.query(
        "UPDATE test_runs SET state=$2,updated_at=now() WHERE id=$1",
        [current, state],
      );
      if (result?.newRun) {
        await c.query("INSERT INTO test_runs(id,state) VALUES($1,$2)", [
          result.newRun.id,
          result.newRun,
        ]);
        await c.query("UPDATE active_run SET run_id=$1", [result.newRun.id]);
      }
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async list() {
    return (
      await this.pool.query(
        "SELECT id, state->'createdAt' AS created_at, state->'running' AS running FROM test_runs ORDER BY updated_at DESC LIMIT 100",
      )
    ).rows;
  }
  async archived(id) {
    return (
      await this.pool.query("SELECT state FROM test_runs WHERE id=$1", [id])
    ).rows[0]?.state;
  }
  async close() {
    await this.pool.end();
  }
}
