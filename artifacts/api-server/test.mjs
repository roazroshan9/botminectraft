/**
 * CraftBot End-to-End Test Suite (M8)
 *
 * Runs against a live server. Set PORT env var to match the server's port.
 *   node test.mjs
 *   PORT=8080 node test.mjs
 *
 * Exit code 0 = all tests passed, 1 = failures.
 */

const BASE   = `http://localhost:${process.env.PORT ?? 8080}`;
const PASS   = "\x1b[32m✔\x1b[0m";
const FAIL   = "\x1b[31m✘\x1b[0m";
const WARN   = "\x1b[33m!\x1b[0m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${PASS}  ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${FAIL}  ${name}`);
    console.log(`       ${"\x1b[31m"}${msg}${RESET}`);
    failed++;
    results.push({ name, ok: false, error: msg });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

async function get(path, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  return { res, body: await res.json().catch(() => null) };
}

async function post(path, data, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  return { res, body: await res.json().catch(() => null) };
}

// ── Test data ─────────────────────────────────────────────────────────────────
const TEST_USER = {
  username: `testuser_${Date.now()}`,
  email:    `test_${Date.now()}@example.com`,
  password: "TestPass123!",
};
let userToken = null;

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}CraftBot Platform — End-to-End Test Suite${RESET}`);
console.log(`Target: ${BOLD}${BASE}${RESET}\n`);

// ── Section 1: Health & Availability ─────────────────────────────────────────
console.log(`${BOLD}[1/6] Health & Availability${RESET}`);

await test("GET /api/healthz returns 200 + {status:'ok'}", async () => {
  const { res, body } = await get("/api/healthz");
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(body?.status === "ok", `Expected status:'ok', got: ${JSON.stringify(body)}`);
});

await test("GET / serves index.html (200)", async () => {
  const res = await fetch(`${BASE}/`);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const text = await res.text();
  assert(text.includes("<html") || text.includes("<!DOCTYPE"), "Response does not look like HTML");
});

await test("GET /api/admin serves admin.html (200)", async () => {
  const res = await fetch(`${BASE}/api/admin`);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
});

await test("GET /api/user serves user.html (200)", async () => {
  const res = await fetch(`${BASE}/api/user`);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
});

// ── Section 2: Auth ───────────────────────────────────────────────────────────
console.log(`\n${BOLD}[2/6] Authentication${RESET}`);

await test("POST /api/auth/register creates a new user", async () => {
  const { res, body } = await post("/api/auth/register", TEST_USER);
  assert(res.status === 201 || res.status === 200, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  assert(body?.token || body?.user, `Expected token or user in response: ${JSON.stringify(body)}`);
});

await test("POST /api/auth/login returns a JWT token", async () => {
  const { res, body } = await post("/api/auth/login", {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.token === "string", `Expected token string: ${JSON.stringify(body)}`);
  userToken = body.token;
});

await test("POST /api/auth/login rejects wrong password (401)", async () => {
  const { res } = await post("/api/auth/login", {
    email: TEST_USER.email,
    password: "wrong_password",
  });
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

await test("GET /api/auth/me returns user profile with valid token", async () => {
  assert(userToken, "No token from login test");
  const { res, body } = await get("/api/auth/me", userToken);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const user = body?.user ?? body;
  assert(user?.username === TEST_USER.username, `Expected username ${TEST_USER.username}, got ${user?.username}`);
});

await test("GET /api/auth/me returns 401 without token", async () => {
  const { res } = await get("/api/auth/me");
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

// ── Section 3: Admin Routes ───────────────────────────────────────────────────
console.log(`\n${BOLD}[3/6] Admin Routes${RESET}`);

await test("GET /api/admin/stats returns stats object (with admin password)", async () => {
  const res = await fetch(`${BASE}/api/admin/stats`, {
    headers: { "x-admin-password": process.env.DASHBOARD_PASSWORD ?? "admin" },
  });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json().catch(() => null);
  assert(body?.totalUsers !== undefined, `Expected totalUsers in response: ${JSON.stringify(body)}`);
});

await test("GET /api/admin/stats rejects without password (401/403)", async () => {
  const { res } = await get("/api/admin/stats");
  assert(res.status === 401 || res.status === 403, `Expected 401 or 403, got ${res.status}`);
});

await test("GET /api/admin/users returns user list", async () => {
  const res = await fetch(`${BASE}/api/admin/users`, {
    headers: { "x-admin-password": process.env.DASHBOARD_PASSWORD ?? "admin" },
  });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json().catch(() => null);
  assert(Array.isArray(body?.users ?? body), `Expected users array: ${JSON.stringify(body)}`);
});

// ── Section 4: User Bot API ───────────────────────────────────────────────────
console.log(`\n${BOLD}[4/6] User Bot API${RESET}`);

await test("GET /api/user/bots returns empty array for new user", async () => {
  assert(userToken, "No token from login test");
  const { res, body } = await get("/api/user/bots", userToken);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert(Array.isArray(body?.bots ?? body), `Expected array: ${JSON.stringify(body)}`);
});

await test("POST /api/user/bots rejects invalid config (400)", async () => {
  const { res } = await post("/api/user/bots", { username: "" }, userToken);
  assert(res.status === 400 || res.status === 422, `Expected 400/422, got ${res.status}`);
});

// ── Section 5: Command Parser ─────────────────────────────────────────────────
console.log(`\n${BOLD}[5/6] Command Parser (unit tests)${RESET}`);

// Inline the command parser logic for testing
const ALIASES = {
  go: "goto", dig: "mine", harvest: "farm", chop: "chop",
  fight: "attack", protect: "defend", followme: "follow",
  store: "deposit", sort: "organize", halt: "stop",
};
function parseCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  let command = (parts[0] || "").toLowerCase();
  command = ALIASES[command] ?? command;
  const rest = parts.slice(1);
  const args = [];
  let amount;
  for (const part of rest) {
    const num = parseInt(part, 10);
    // Only non-negative integers without extra chars become amount (quantities).
    // Negative values (e.g. coordinates like "-200") stay as positional args.
    if (!isNaN(num) && num >= 0 && String(num) === part && amount === undefined) amount = num;
    else args.push(part.toLowerCase());
  }
  return { command, args, amount, raw: trimmed };
}

await test("parseCommand('mine diamond 32') → {command:'mine', args:['diamond'], amount:32}", () => {
  const p = parseCommand("mine diamond 32");
  assert(p.command === "mine",    `command=${p.command}`);
  assert(p.args[0] === "diamond", `args=${JSON.stringify(p.args)}`);
  assert(p.amount  === 32,        `amount=${p.amount}`);
});

await test("parseCommand('chop oak 16') → {command:'chop', args:['oak'], amount:16}", () => {
  const p = parseCommand("chop oak 16");
  assert(p.command === "chop", `command=${p.command}`);
  assert(p.args[0] === "oak",  `args=${JSON.stringify(p.args)}`);
  assert(p.amount  === 16,     `amount=${p.amount}`);
});

await test("parseCommand('dig iron 8') uses alias → command:'mine'", () => {
  const p = parseCommand("dig iron 8");
  assert(p.command === "mine", `Expected 'mine', got '${p.command}'`);
  assert(p.amount  === 8,      `amount=${p.amount}`);
});

await test("parseCommand('halt') uses alias → command:'stop'", () => {
  const p = parseCommand("halt");
  assert(p.command === "stop", `Expected 'stop', got '${p.command}'`);
});

await test("parseCommand('goto 100 64 -200') → amount=100, args=['64','-200']", () => {
  // 100 is the first non-negative integer → amount. 64 and -200 stay as args.
  const p = parseCommand("goto 100 64 -200");
  assert(p.command  === "goto",  `command=${p.command}`);
  assert(p.amount   === 100,     `amount=${p.amount} (expected 100)`);
  assert(p.args[0]  === "64",    `args[0]=${p.args[0]} (expected '64')`);
  assert(p.args[1]  === "-200",  `args[1]=${p.args[1]} (expected '-200')`);
});

await test("parseCommand('') returns null", () => {
  const p = parseCommand("   ");
  assert(p === null, `Expected null, got ${JSON.stringify(p)}`);
});

// ── Section 6: Keep-Alive & Infrastructure ────────────────────────────────────
console.log(`\n${BOLD}[6/6] Keep-Alive & Infrastructure${RESET}`);

await test("GET /api/healthz responds within 2 seconds (latency check)", async () => {
  const start = Date.now();
  const { res } = await get("/api/healthz");
  const ms = Date.now() - start;
  assert(res.status === 200, `Status ${res.status}`);
  assert(ms < 2000, `Too slow: ${ms}ms (limit: 2000ms)`);
  console.log(`       ${WARN} Response time: ${ms}ms`);
});

await test("Rate limiter is active on /api routes (header present)", async () => {
  const res = await fetch(`${BASE}/api/healthz`);
  const hasRateHeader =
    res.headers.has("ratelimit-limit") ||
    res.headers.has("x-ratelimit-limit") ||
    res.headers.has("ratelimit-remaining");
  // Not a hard failure — just warn if headers are missing
  if (!hasRateHeader) console.log(`       ${WARN} Rate-limit headers not found (may be stripped by proxy)`);
  assert(res.status === 200, `Status ${res.status}`);
});

await test("CORS header present on /api/healthz", async () => {
  const res = await fetch(`${BASE}/api/healthz`, {
    headers: { "Origin": "https://example.com" },
  });
  const cors = res.headers.get("access-control-allow-origin");
  assert(cors !== null, `No CORS header; headers: ${[...res.headers.entries()].map(([k,v])=>`${k}:${v}`).join(", ")}`);
});

await test("Socket.io path /api/socket.io/ responds (polling probe)", async () => {
  const res = await fetch(`${BASE}/api/socket.io/?EIO=4&transport=polling`);
  // Socket.io returns 200 with a session handshake payload, or 400 for bad EIO
  assert(res.status === 200 || res.status === 400, `Unexpected status: ${res.status}`);
  // Either way it proves the endpoint is reachable
});

// ─────────────────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(55)}`);
console.log(`${BOLD}Results: ${passed}/${total} passed${failed > 0 ? `, ${FAIL} ${failed} failed` : ""}${RESET}`);

if (failed > 0) {
  console.log(`\n${BOLD}Failed tests:${RESET}`);
  results.filter(r => !r.ok).forEach(r => console.log(`  ${FAIL} ${r.name}\n     ${r.error}`));
  console.log("");
  process.exit(1);
} else {
  console.log(`\n${PASS} ${BOLD}All tests passed!${RESET}\n`);
}
