import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";
import {
  createRun,
  command,
  tick,
  report,
  validateConfig,
  Fault,
} from "../web/engine.mjs";

const { DATABASE_URL, ADMIN_TOKEN, TEST_PASSWORD, TOKEN_SECRET } = process.env;
for (const [key, value] of Object.entries({
  DATABASE_URL,
  ADMIN_TOKEN,
  TEST_PASSWORD,
  TOKEN_SECRET,
}))
  if (!value || (key !== "DATABASE_URL" && value.length < 16))
    throw new Error(
      `${key} must be set; secrets require at least 16 characters. Use scripts/setup.mjs.`,
    );
const origins = (
  process.env.ALLOWED_ORIGINS ||
  "https://jungminlim-ggms.github.io,http://localhost:8080,http://127.0.0.1:8080"
).split(",");
const root = fileURLToPath(new URL("../web/", import.meta.url));
const store = new Store(DATABASE_URL);
await store.init();
const safeEqual = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const sign = (x) =>
  createHmac("sha256", TOKEN_SECRET).update(x).digest("base64url");
function token(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b}.${sign(b)}`;
}
function verify(t, now) {
  try {
    const [b, s] = t.split(".");
    if (!safeEqual(sign(b), s)) throw 0;
    const p = JSON.parse(Buffer.from(b, "base64url"));
    if (p.exp <= now) throw 0;
    return p;
  } catch {
    throw new Fault("AUTH", "로그인이 만료되었습니다. 다시 로그인하세요.", 401);
  }
}
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 32768)
      throw new Fault("BODY", "요청이 너무 큽니다.", 413);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Fault("JSON", "올바른 JSON 요청이 필요합니다.", 400);
  }
}
function rate(s, key, limit, now) {
  const minute = Math.floor(now / 60000);
  const item = s.rates[key];
  if (!item || item.minute !== minute) s.rates[key] = { minute, count: 0 };
  return ++s.rates[key].count > limit;
}
function log(s, event) {
  s.events.push(event);
  if (s.events.length > 5000) s.events.shift();
}
const server = http.createServer(
  { requestTimeout: 15000, headersTimeout: 10000 },
  async (req, res) => {
    const requestId = randomUUID(),
      started = performance.now();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin))
      return send(res, 403, {
        code: "ORIGIN",
        message: "허용되지 않은 웹사이트 주소입니다.",
      });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Admin-Token",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const path = resolve(
          root,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
        );
        if (!path.startsWith(root))
          throw new Fault("PATH", "잘못된 경로입니다.", 400);
        try {
          const bytes = await readFile(path);
          res.writeHead(200, {
            "Content-Type":
              {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css",
                ".mjs": "text/javascript",
                ".js": "text/javascript",
                ".svg": "image/svg+xml",
              }[extname(path)] || "application/octet-stream",
          });
          return res.end(bytes);
        } catch {
          return send(res, 404, { code: "NOT_FOUND" });
        }
      }
      if (url.pathname === "/api/health") {
        await store.pool.query("SELECT 1");
        return send(res, 200, {
          ok: true,
          storage: "postgresql",
          version: "1.0.0",
        });
      }
      const admin = url.pathname.startsWith("/api/admin/");
      if (admin && !safeEqual(req.headers["x-admin-token"], ADMIN_TOKEN))
        throw new Fault("ADMIN", "관리자 인증이 필요합니다.", 401);
      if (admin && req.method === "GET" && url.pathname === "/api/admin/runs")
        return send(res, 200, await store.list());
      if (
        admin &&
        req.method === "GET" &&
        url.pathname === "/api/admin/report"
      ) {
        const s = url.searchParams.has("run")
          ? await store.archived(url.searchParams.get("run"))
          : await store.transaction((s) => structuredClone(s));
        if (!s) throw new Fault("RUN", "실행을 찾을 수 없습니다.", 404);
        return send(res, 200, report(s));
      }
      if (req.method !== "POST")
        throw new Fault("METHOD", "POST 요청이 필요합니다.", 405);
      const data = await body(req);
      const action = url.pathname.split("/").at(-1);
      let delay = 0;
      const result = await store.transaction((s, now) => {
        tick(s, now);
        if (admin) {
          if (action === "reset") {
            if (s.running)
              throw new Fault(
                "RUNNING",
                "테스트를 중지한 뒤 새 실행을 생성하세요.",
              );
            const next = createRun(randomUUID(), now, data.config || s.config);
            log(s, {
              at: now,
              action: "admin.reset",
              requestId,
              nextRun: next.id,
            });
            return { newRun: next, runId: next.id };
          }
          if (action === "config") {
            const allowed = [
              "paused",
              "salesPaused",
              "rateLimit",
              "requestsPerMinute",
              "challenge",
              "delayMs",
              "failureEvery",
            ];
            if (Object.keys(data).some((k) => !allowed.includes(k)))
              throw new Fault(
                "CONFIG",
                "규모·시각 설정은 새 실행 생성 시 변경하세요.",
                400,
              );
            Object.assign(s.config, validateConfig(data));
            log(s, {
              at: now,
              action: "admin.config",
              requestId,
              config: data,
            });
            return { ok: true };
          }
          if (action === "stop" || action === "start") {
            s.running = action === "start";
            log(s, { at: now, action: `admin.${action}`, requestId });
            return { ok: true };
          }
          throw new Fault("ACTION", "알 수 없는 관리자 요청입니다.", 404);
        }
        const ip = req.socket.remoteAddress || "unknown"; // Do not trust client-controlled X-Forwarded-For.
        if (action === "login") {
          if (rate(s, `login:${ip}`, 60, now))
            return {
              error: {
                code: "RATE_LIMIT",
                message: "로그인 요청이 많습니다. 1분 후 재시도하세요.",
                status: 429,
              },
            };
          if (
            !safeEqual(data.password, TEST_PASSWORD) ||
            !/^user\d{5}$/.test(data.user) ||
            +data.user.slice(4) < 1 ||
            +data.user.slice(4) > s.config.accounts
          )
            return {
              error: {
                code: "AUTH",
                message: "계정 또는 테스트 암호를 확인하세요.",
                status: 401,
              },
            };
          const p = {
            user: data.user,
            run: s.id,
            sid: randomUUID(),
            bot: data.bot === true,
            exp: now + 86400000,
          };
          return { token: token(p), user: p.user, runId: s.id };
        }
        const auth = verify(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
          now,
        );
        if (auth.run !== s.id || s.revoked[auth.sid])
          throw new Fault(
            "AUTH",
            "실행이 변경되었거나 로그아웃한 세션입니다.",
            401,
          );
        const m = s.metrics;
        m.requests++;
        m[auth.bot ? "botRequests" : "humanRequests"]++;
        const accountBlocked = rate(
          s,
          `user:${auth.user}`,
          s.config.requestsPerMinute,
          now,
        );
        const ipBlocked = rate(
          s,
          `ip:${ip}`,
          s.config.requestsPerMinute * 20,
          now,
        );
        const sessionBlocked = rate(
          s,
          `session:${auth.sid}`,
          s.config.requestsPerMinute,
          now,
        );
        const replay =
          action === "pay" && Boolean(s.keys[`${auth.user}:${data.key}`]);
        const backup = structuredClone(s);
        let output;
        try {
          if (
            s.config.rateLimit &&
            (accountBlocked || ipBlocked || sessionBlocked)
          ) {
            m[auth.bot ? "blockedBot" : "blockedHuman"]++;
            throw new Fault(
              "RATE_LIMIT",
              "요청 제한에 도달했습니다. 잠시 후 재시도하세요.",
              429,
            );
          }
          if (
            s.config.failureEvery > 0 &&
            m.requests % s.config.failureEvery === 0
          )
            throw new Fault(
              "INJECTED",
              "테스트용 서버 오류가 주입되었습니다.",
              503,
            );
          output = command(s, action, data, auth.user, now, requestId);
          if (action === "logout") s.revoked[auth.sid] = auth.exp;
          m.success++;
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          // Business action is atomic even when it throws after a future code change.
          const metrics = s.metrics;
          Object.assign(s, backup);
          s.metrics = metrics;
          m.errors[e.code] = (m.errors[e.code] || 0) + 1;
          output = {
            error: { code: e.code, message: e.message, status: e.status },
          };
        }
        delay = s.config.delayMs;
        const elapsed = performance.now() - started + delay;
        m.latencies.push(elapsed);
        if (m.latencies.length > 5000) m.latencies.shift();
        log(s, {
          requestId,
          at: now,
          action,
          user: auth.user,
          bot: auth.bot,
          code: output.error?.code || "OK",
          durationMs: Math.round(elapsed),
          target: data.show || data.holdId || data.orderId || null,
        });
        if (
          action === "pay" &&
          data.scenario === "lost" &&
          !replay &&
          !output.error
        )
          output = { ...output, dropResponse: true };
        return output;
      });
      if (delay) await new Promise((r) => setTimeout(r, delay)); // No database lock while waiting.
      if (result?.dropResponse) {
        req.socket.destroy();
        return;
      }
      if (result?.newRun) delete result.newRun;
      send(
        res,
        result?.error?.status || 200,
        result?.error ? { ...result.error, requestId } : result,
      );
    } catch (e) {
      const expected = e instanceof Fault;
      if (!expected)
        console.error(
          JSON.stringify({ requestId, code: e.code || "INTERNAL" }),
        );
      send(res, expected ? e.status : 503, {
        code: expected ? e.code : "STORAGE_UNAVAILABLE",
        message: expected
          ? e.message
          : "저장소 응답을 확인할 수 없어 처리를 중지했습니다. 잠시 후 상태를 조회하세요.",
        requestId,
      });
    }
  },
);
let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    await store.transaction((s, now) => {
      tick(s, now);
      const minute = Math.floor(now / 60000);
      for (const k of Object.keys(s.rates))
        if (s.rates[k].minute < minute - 1) delete s.rates[k];
      for (const k of Object.keys(s.revoked))
        if (s.revoked[k] <= now) delete s.revoked[k];
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        worker: "paused",
        code: e.code || "STORAGE_UNAVAILABLE",
      }),
    );
  } finally {
    working = false;
  }
}, 1000);
server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () =>
  console.log("Macro Tester: http://localhost:" + (process.env.PORT || 8080)),
);
async function close() {
  clearInterval(timer);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
