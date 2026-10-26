import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../server/store.mjs";
import { createRun, command, tick, audit } from "../web/engine.mjs";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: two independent pools, competing holds, worker limits, durable restart and rollback",
  { skip: !url, timeout: 180000 },
  async () => {
    const a = new Store(url),
      b = new Store(url);
    await a.init();
    await b.init();
    try {
      await a.transaction(() => ({
        newRun: createRun(randomUUID(), Date.now(), {
          accounts: 1000,
          capacity: 1000,
          admitPerSecond: 1000,
          sessionSeconds: 3600,
          holdSeconds: 900,
        }),
      }));
      await a.transaction((s, now) => {
        for (let i = 1; i <= 1000; i++)
          command(
            s,
            "queue",
            { show: "aurora" },
            "user" + String(i).padStart(5, "0"),
            now,
            randomUUID(),
          );
      });
      const results = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          (i % 2 ? a : b).transaction((s, now) => {
            tick(s, now);
            try {
              command(
                s,
                "hold",
                { show: "aurora", seats: ["A01"] },
                "user" + String(i + 1).padStart(5, "0"),
                now,
                randomUUID(),
              );
              return "OK";
            } catch (e) {
              return e.code;
            }
          }),
        ),
      );
      assert.equal(results.filter((x) => x === "OK").length, 1);
      assert.equal(results.filter((x) => x === "SEAT_TAKEN").length, 999);
      const before = await a.transaction((s) => structuredClone(s));
      assert.deepEqual(audit(before), []);
      await assert.rejects(
        a.transaction((s) => {
          s.running = false;
          throw new Error("rollback");
        }),
      );
      assert.equal(await b.transaction((s) => s.running), true);
      const winner = before.holds[0];
      const orders = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          (i % 2 ? a : b).transaction((s, now) =>
            command(
              s,
              "pay",
              {
                holdId: winner.id,
                scenario: "duplicate",
                key: "same-payment-key",
              },
              winner.user,
              now,
              randomUUID(),
            ),
          ),
        ),
      );
      assert.equal(new Set(orders.map((o) => o.id)).size, 1);
      await a.close();
      const reopened = new Store(url);
      await reopened.init();
      try {
        await reopened.transaction((s, now) => tick(s, now + 1000));
        const recovered = await reopened.transaction((s) => structuredClone(s));
        assert.equal(recovered.orders.length, 1);
        assert.equal(recovered.orders[0].status, "confirmed");
        assert.deepEqual(audit(recovered), []);
      } finally {
        await reopened.close();
      }
    } finally {
      await a.close().catch(() => {});
      await b.close();
    }
  },
);

test(
  "HTTP: two API processes enforce auth, atomic holds, lost responses and restart recovery",
  { skip: !url, timeout: 90000 },
  async () => {
    const admin = "ci-only-admin-token-0001",
      password = "ci-only-test-password-01",
      secret = "ci-only-signing-secret-01";
    const children = new Set();
    async function launch(port) {
      const child = spawn(process.execPath, ["server/index.mjs"], {
        env: {
          ...process.env,
          DATABASE_URL: url,
          ADMIN_TOKEN: admin,
          TEST_PASSWORD: password,
          TOKEN_SECRET: secret,
          PORT: String(port),
          ALLOWED_ORIGINS: "https://jungminlim-ggms.github.io",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      for (let i = 0; i < 100; i++) {
        if (output.includes("Macro Tester:")) return child;
        if (child.exitCode !== null) throw new Error("API exited: " + output);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("API did not start: " + output);
    }
    async function stop(child) {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
      children.delete(child);
    }
    async function req(port, action, data = {}, token = "", asAdmin = false) {
      const r = await fetch(`http://127.0.0.1:${port}/api/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(asAdmin
            ? { "X-Admin-Token": admin }
            : { Authorization: "Bearer " + token }),
        },
        body: JSON.stringify(data),
      });
      return { status: r.status, data: await r.json() };
    }
    try {
      let one = await launch(8181);
      const two = await launch(8182);
      assert.equal((await req(8181, "state")).status, 401);
      assert.equal((await req(8181, "admin/stop")).status, 401);
      await req(8181, "admin/stop", {}, "", true);
      assert.equal(
        (
          await req(
            8181,
            "admin/reset",
            { config: { capacity: 10, admitPerSecond: 10 } },
            "",
            true,
          )
        ).status,
        200,
      );
      const login = await req(8181, "login", {
        user: "user00001",
        password,
        bot: true,
      });
      assert.equal(login.status, 200);
      const t = login.data.token;
      assert.equal(
        (await req(8182, "hold", { show: "aurora", seats: ["A01"] }, t)).data
          .code,
        "ENTRY_REQUIRED",
      );
      const q = await Promise.all([
        req(8181, "queue", { show: "aurora" }, t),
        req(8182, "queue", { show: "aurora" }, t),
      ]);
      assert.equal(
        q[0].data.shows[0].queue.number,
        q[1].data.shows[0].queue.number,
      );
      const attempts = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          req(
            i % 2 ? 8181 : 8182,
            "hold",
            { show: "aurora", seats: ["A01"] },
            t,
          ),
        ),
      );
      const winners = attempts.filter((x) => x.status === 200);
      assert.equal(winners.length, 1);
      const h = winners[0].data;
      const payment = {
        holdId: h.id,
        scenario: "lost",
        key: "lost-response-key",
      };
      await assert.rejects(req(8181, "pay", payment, t));
      await stop(one);
      await stop(two);
      one = await launch(8181);
      let state;
      for (let i = 0; i < 30; i++) {
        state = (await req(8181, "state", {}, t)).data;
        if (state.orders?.[0]?.status === "confirmed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(state.orders.length, 1);
      assert.equal(state.orders[0].status, "confirmed");
      const retry = await req(8181, "pay", payment, t);
      assert.equal(retry.status, 200);
      assert.equal(retry.data.id, state.orders[0].id);
      assert.equal(
        (await req(8181, "pay", { ...payment, scenario: "success" }, t)).data
          .code,
        "IDEMPOTENCY_CONFLICT",
      );
      assert.equal(
        (await req(8181, "cancel", { orderId: state.orders[0].id }, t)).data
          .status,
        "cancelled",
      );
      await req(8181, "logout", {}, t);
      assert.equal((await req(8181, "state", {}, t)).status, 401);
    } finally {
      await Promise.all([...children].map(stop));
    }
  },
);
