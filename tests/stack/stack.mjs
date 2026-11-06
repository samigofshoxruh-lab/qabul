// Локальная копия Supabase: настоящие Postgres, PostgREST и Edge Functions,
// заглушка входа (GoTrue) и заглушка API соцсетей. Нужна для e2e и UI-тестов.
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { startMockPlatforms } from "./mock_platforms.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const JWT_SECRET = "local-test-jwt-secret-local-test-jwt-secret";
export const PORTS = { gateway: 54321, rest: 54330, mock: 54340, fnBase: 54350 };
export const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`;
export const MOCK_URL = `http://127.0.0.1:${PORTS.mock}`;
export const CRON_SECRET = "cron-test-secret";
export const ENCRYPTION_KEY = "local-test-encryption-key-0123456789";
const FUNCTIONS = ["webhook", "channels", "send-message", "team", "refresh-tokens", "platform", "reminders"];
const JWT_REQUIRED = new Set(["channels", "send-message", "team", "platform"]);

const b64 = (v) => Buffer.from(v).toString("base64url");
export function signJwt(payload) {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400, ...payload }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function readJwt(token) {
  const [head, body, sig] = String(token).split(".");
  if (!sig) return null;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  if (expected !== sig) return null;
  return JSON.parse(Buffer.from(body, "base64url"));
}
export const ANON_KEY = signJwt({ role: "anon" });
export const SERVICE_KEY = signJwt({ role: "service_role" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForPort(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`Не дождались ${url}`);
}

export async function startStack({ postgrestBin, denoBin = path.join(ROOT, "node_modules/.bin/deno") }) {
  const db = new pg.Pool({ connectionString: "postgres://postgres@127.0.0.1:54329/postgres", max: 4 });
  const children = [];

  const rest = spawn(postgrestBin, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: "postgres://authenticator:authenticator@127.0.0.1:54329/postgres",
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: JWT_SECRET,
      PGRST_SERVER_PORT: String(PORTS.rest),
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_LOG_LEVEL: "error",
    },
    stdio: "inherit",
  });
  children.push(rest);

  const mock = await startMockPlatforms(PORTS.mock);

  FUNCTIONS.forEach((fn, i) => {
    children.push(spawn(denoBin, ["run", "--allow-all", "--no-prompt", path.join(ROOT, "tests/stack/serve_fn.ts"), fn, String(PORTS.fnBase + i)], {
      env: {
        ...process.env,
        DENO_NO_PACKAGE_JSON: "1",
        SUPABASE_URL: GATEWAY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
        CRON_SECRET,
        MOCK_PLATFORMS_URL: MOCK_URL,
      },
      stdio: "inherit",
    }));
  });

  const session = (user) => {
    const payload = { sub: user.id, role: "authenticated", email: user.email, aud: "authenticated", app_metadata: user.raw_app_meta_data, user_metadata: user.raw_user_meta_data };
    return {
      access_token: signJwt(payload),
      refresh_token: Buffer.from(user.id).toString("base64url"),
      token_type: "bearer",
      expires_in: 86400,
      expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: publicUser(user),
    };
  };
  const publicUser = (u) => ({
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    app_metadata: u.raw_app_meta_data, user_metadata: u.raw_user_meta_data, created_at: u.created_at,
  });
  const hash = (p) => crypto.createHash("sha256").update(p).digest("hex");

  async function auth(req, res, url, body) {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify(data));
    };
    const p = url.pathname.replace("/auth/v1", "");
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const claims = readJwt(bearer);

    // Как enable_signup = false на настоящем проекте.
    if (p === "/signup" && req.method === "POST") {
      return send(422, { code: 422, error_code: "signup_disabled", msg: "Signups not allowed for this instance" });
    }
    if (p === "/token" && url.searchParams.get("grant_type") === "password") {
      const { rows } = await db.query("select * from auth.users where email = $1 and encrypted_password = $2", [body.email, hash(body.password)]);
      if (!rows[0]) return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      return send(200, session(rows[0]));
    }
    if (p === "/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const id = Buffer.from(String(body.refresh_token), "base64url").toString();
      const { rows } = await db.query("select * from auth.users where id = $1", [id]);
      if (!rows[0]) return send(400, { msg: "Invalid refresh token" });
      return send(200, session(rows[0]));
    }
    if (p === "/user") {
      if (!claims?.sub) return send(401, { msg: "invalid JWT" });
      const { rows } = await db.query("select * from auth.users where id = $1", [claims.sub]);
      return rows[0] ? send(200, publicUser(rows[0])) : send(401, { msg: "user not found" });
    }
    if (p === "/logout") return send(204, {});
    if (p === "/admin/users" && req.method === "POST") {
      if (claims?.role !== "service_role") return send(403, { msg: "forbidden" });
      const exists = await db.query("select 1 from auth.users where email = $1", [body.email]);
      if (exists.rowCount) return send(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      // Как настоящий GoTrue: сначала вставка пользователя, app_metadata записывается отдельным обновлением.
      const inserted = await db.query(
        "insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, $2, $3) returning id",
        [body.email, hash(body.password), body.user_metadata ?? {}],
      );
      const { rows } = await db.query(
        "update auth.users set raw_app_meta_data = $1 where id = $2 returning *",
        [body.app_metadata ?? {}, inserted.rows[0].id],
      );
      return send(200, publicUser(rows[0]));
    }
    if (p.startsWith("/admin/users/") && req.method === "GET") {
      if (claims?.role !== "service_role") return send(403, { msg: "forbidden" });
      const { rows } = await db.query("select * from auth.users where id = $1", [p.split("/").pop()]);
      return rows[0] ? send(200, publicUser(rows[0])) : send(404, { msg: "user not found" });
    }
    if (p.startsWith("/admin/users/") && req.method === "PUT") {
      if (claims?.role !== "service_role") return send(403, { msg: "forbidden" });
      const { rows } = await db.query("update auth.users set encrypted_password = $1 where id = $2 returning *", [hash(body.password), p.split("/").pop()]);
      return rows[0] ? send(200, publicUser(rows[0])) : send(404, { msg: "user not found" });
    }
    if (p.startsWith("/admin/users/") && req.method === "DELETE") {
      if (claims?.role !== "service_role") return send(403, { msg: "forbidden" });
      await db.query("delete from auth.users where id = $1", [p.split("/").pop()]);
      return send(200, {});
    }
    return send(404, { msg: `not implemented: ${p}` });
  }

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-expose-headers": "*",
  };

  function proxy(req, res, targetPort, targetPath, raw) {
    const upstream = http.request({
      host: "127.0.0.1", port: targetPort, method: req.method, path: targetPath,
      headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, ...CORS });
      r.pipe(res);
    });
    upstream.on("error", (e) => {
      res.writeHead(502, CORS);
      res.end(String(e));
    });
    upstream.end(raw);
  }

  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, GATEWAY);
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      try {
        if (url.pathname.startsWith("/auth/v1")) {
          return await auth(req, res, url, raw.length ? JSON.parse(raw.toString()) : {});
        }
        if (url.pathname.startsWith("/rest/v1")) {
          return proxy(req, res, PORTS.rest, url.pathname.replace("/rest/v1", "") + url.search, raw);
        }
        if (url.pathname.startsWith("/functions/v1/")) {
          const fn = url.pathname.split("/")[3];
          const index = FUNCTIONS.indexOf(fn);
          if (index < 0) {
            res.writeHead(404, CORS);
            return res.end("no such function");
          }
          // Как verify_jwt = true на платформе.
          if (JWT_REQUIRED.has(fn) && !readJwt((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))) {
            res.writeHead(401, { "content-type": "application/json", ...CORS });
            return res.end(JSON.stringify({ code: 401, message: "Invalid JWT" }));
          }
          return proxy(req, res, PORTS.fnBase + index, url.pathname.replace("/functions/v1", "") + url.search, raw);
        }
        res.writeHead(404, CORS);
        res.end("not found");
      } catch (e) {
        console.error(e);
        res.writeHead(500, CORS);
        res.end(String(e));
      }
    });
  });
  await new Promise((r) => gateway.listen(PORTS.gateway, "127.0.0.1", r));

  await waitForPort(`http://127.0.0.1:${PORTS.rest}/`);
  for (let i = 0; i < FUNCTIONS.length; i++) {
    await waitForPort(`http://127.0.0.1:${PORTS.fnBase + i}/`, 240);
  }

  return {
    db,
    async stop() {
      children.forEach((c) => c.kill("SIGTERM"));
      gateway.close();
      mock.close();
      await db.end();
    },
  };
}
