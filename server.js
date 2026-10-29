
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

// Database is required: do not silently lose moderation records.
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Configure a PostgreSQL database in Render.");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_reports (
    id BIGSERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT NOT NULL, reporter TEXT NOT NULL, reported TEXT NOT NULL,
    reported_client_id TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_bans (
    client_id TEXT PRIMARY KEY, until_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_blocks (
    pair_key TEXT PRIMARY KEY)`);
  const [savedReports, savedBans, savedBlocks] = await Promise.all([
    pool.query(`SELECT time, reason, reporter, reported, reported_client_id FROM moderation_reports ORDER BY id DESC LIMIT 500`),
    pool.query(`SELECT client_id, until_at FROM moderation_bans WHERE until_at > NOW()`),
    pool.query(`SELECT pair_key FROM moderation_blocks`)
  ]);
  reports.push(...savedReports.rows.reverse().map(r => ({
    time: r.time.toISOString(), reason: r.reason, reporter: r.reporter,
    reported: r.reported, reportedClientId: r.reported_client_id
  })));
  for (const r of savedBans.rows) bannedIds.set(r.client_id, new Date(r.until_at).getTime());
  for (const r of savedBlocks.rows) blockedPairs.add(r.pair_key);
  await pool.query(`DELETE FROM moderation_bans WHERE until_at <= NOW()`);
  console.log("PostgreSQL moderation data loaded");
}


// Create the website server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Socket.IO requests are handled automatically
  // by the Socket.IO server attached below.

  // Private developer reset. The secret is stored only in Render environment variables.
  if (url.pathname === "/developer-reset" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>RandomChat developer reset</title><style>body{font:16px system-ui;background:#10131b;color:white;max-width:480px;margin:8vh auto;padding:20px}input,button{font:inherit;padding:14px;border-radius:8px;width:100%;box-sizing:border-box;margin-top:12px}button{background:#18a86b;color:white;border:0;cursor:pointer}</style></head><body><h2>Developer testing reset</h2><p>Private testing only. This clears temporary server blocks and the blocked list on <strong>this browser</strong>. Repeat on each test device.</p><form id="form"><input id="secret" type="password" autocomplete="off" placeholder="Developer reset secret" required><button>Reset testing blocks</button></form><p id="result" role="status"></p><script>document.getElementById('form').onsubmit=async(e)=>{e.preventDefault();const result=document.getElementById('result');result.textContent='Resetting…';try{const response=await fetch('/api/developer/reset-blocks',{method:'POST',headers:{'Content-Type':'application/json','X-Developer-Reset-Token':document.getElementById('secret').value},body:'{}'});if(!response.ok)throw Error(response.status===401?'Incorrect password or reset not configured':'Reset failed');localStorage.removeItem('randomchat-blocked-ids');result.textContent='Reset complete on this browser. Refresh RandomChat. Repeat on your other test devices.';document.getElementById('secret').value='';}catch(err){result.textContent=err.message;}};</script></body></html>`);
    return;
  }
  if (url.pathname === "/api/developer/reset-blocks" && req.method === "POST") {
    const configured = process.env.DEVELOPER_RESET_TOKEN || "";
    const provided = req.headers["x-developer-reset-token"] || "";
    const a = Buffer.from(configured);
    const b = Buffer.from(typeof provided === "string" ? provided : "");
    if (a.length < 24 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    pool.query("DELETE FROM moderation_blocks").then(() => {
      blockedPairs.clear();
      for (const client of io.sockets.sockets.values()) client.data.blocked = [];
      console.log("DEVELOPER_TEST_BLOCK_RESET", new Date().toISOString());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
    }).catch(error => {
      console.error("RESET_DB_ERROR", error);
      res.writeHead(503); res.end("Database unavailable");
    });
    return;
  }
  // Private beta admin panel: separate secret from developer reset.
  if (url.pathname === "/admin" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
    fs.createReadStream(path.join(__dirname, "admin.html")).pipe(res);
    return;
  }
  if (url.pathname.startsWith("/api/admin/")) {
    const configured = process.env.ADMIN_DASHBOARD_TOKEN || "";
    const provided = req.headers["x-admin-token"];
    const a = Buffer.from(configured);
    const b = Buffer.from(typeof provided === "string" ? provided : "");
    if (a.length < 24 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Invalid admin token or not configured" }));
      return;
    }
    if (url.pathname === "/api/admin/overview" && req.method === "GET") {
      const now = Date.now();
      for (const [id, until] of bannedIds) if (until <= now) bannedIds.delete(id);
      const payload = { ok: true, online: io.engine.clientsCount, waiting: waiting.filter(id => io.sockets.sockets.has(id)).length, activeChats: partners.size / 2, reports: reports.slice(-100).reverse(), bans: [...bannedIds].map(([clientId, until]) => ({ clientId, until: new Date(until).toISOString() })) };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === "/api/admin/ban" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
      req.on("end", () => {
        let input;
        try { input = JSON.parse(body); } catch { input = {}; }
        const clientId = input.clientId;
        const hours = Number(input.hours);
        if (typeof clientId !== "string" || !idPattern.test(clientId) || ![1,24,168].includes(hours)) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Invalid user ID or duration" })); return;
        }
        const until = Date.now() + hours * 3600000;
        pool.query(`INSERT INTO moderation_bans (client_id, until_at) VALUES ($1, $2)
          ON CONFLICT (client_id) DO UPDATE SET until_at = EXCLUDED.until_at`,
          [clientId, new Date(until)]).then(() => {
          bannedIds.set(clientId, until);
          for (const sock of io.sockets.sockets.values()) {
            if (sock.data.clientId === clientId) { sock.emit("moderation-warning", "Access temporarily restricted."); sock.disconnect(true); }
          }
          console.log("ADMIN_BAN", JSON.stringify({ clientId, hours, time: new Date().toISOString() }));
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ok: true }));
        }).catch(error => { console.error("BAN_DB_ERROR", error); res.writeHead(503); res.end(JSON.stringify({ ok: false, error: "Database unavailable" })); });
      });
      return;
    }
    res.writeHead(404); res.end("Not found"); return;
  }
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    res.writeHead(404);
    res.end("Page not found");
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("Cannot load index.html");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });
    res.end(data);
  });
});

// Attach Socket.IO to the same HTTP server
const io = new Server(server);

// Users waiting to be matched
const waiting = [];

// Store connected partners
const partners = new Map();
// Beta moderation state: kept in memory until the server restarts.
const reports = [];
const bannedIds = new Map(); // Temporary bans: in-memory beta version.
const reportTimes = new Map();
const skipTimes = new Map();
const recentPartners = new Map();
const blockedPairs = new Set();
const allowedReasons = new Set(["nudity", "harassment", "hate", "spam", "underage", "other"]);
const idPattern = /^[a-f0-9-]{36}$/i;
const pairKey = (a, b) => [a, b].sort().join(":");
function rateLimited(map, id, limit, windowMs) {
  const now = Date.now();
  const history = (map.get(id) || []).filter(t => now - t < windowMs);
  if (history.length >= limit) { map.set(id, history); return true; }
  history.push(now); map.set(id, history); return false;
}
function eligible(a, b) {
  if (!a.data.clientId || !b.data.clientId) return false;
  if ((bannedIds.get(a.data.clientId) || 0) > Date.now() || (bannedIds.get(b.data.clientId) || 0) > Date.now()) return false;
  const key = pairKey(a.data.clientId, b.data.clientId);
  return !blockedPairs.has(key) &&
    !(a.data.blocked || []).includes(b.data.clientId) &&
    !(b.data.blocked || []).includes(a.data.clientId);
}


function removeWaiting(id) {
  let index = waiting.indexOf(id);

  while (index !== -1) {
    waiting.splice(index, 1);
    index = waiting.indexOf(id);
  }
}

function findPartner(socket) {
  if (!socket.data.ready || partners.has(socket.id)) {
    return;
  }

  removeWaiting(socket.id);

  const deferred = [];
  while (waiting.length > 0) {
    const otherId = waiting.shift();
    const other = io.sockets.sockets.get(otherId);

    if (
      !other ||
      !other.data.ready ||
      otherId === socket.id ||
      partners.has(otherId)
    ) {
      continue;
    }

    if (!eligible(socket, other)) { deferred.push(otherId); continue; }
    waiting.push(...deferred);
    partners.set(socket.id, otherId);
    partners.set(otherId, socket.id);

    socket.emit("matched", {
      partnerId: otherId,
      initiator: true
    });

    other.emit("matched", {
      partnerId: socket.id,
      initiator: false
    });

    recentPartners.set(socket.id, { id: otherId, at: Date.now() });
    recentPartners.set(otherId, { id: socket.id, at: Date.now() });
    console.log("Matched:", socket.id, otherId);
    return;
  }

  waiting.push(...deferred);
  waiting.push(socket.id);
  socket.emit("waiting");
}

function leavePartner(socket) {
  removeWaiting(socket.id);

  const otherId = partners.get(socket.id);

  if (!otherId) return;

  partners.delete(socket.id);
  partners.delete(otherId);

  const other = io.sockets.sockets.get(otherId);

  if (other) {
    other.emit("partner-left");

    if (other.data.ready) {
      findPartner(other);
    }
  }
}

// Handle user connections
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.data.ready = false;
  socket.data.clientId = null;
  socket.data.blocked = [];
  socket.on("identify", ({ clientId, blocked } = {}) => {
    if (typeof clientId !== "string" || !idPattern.test(clientId)) return;
    if ((bannedIds.get(clientId) || 0) > Date.now()) { socket.emit("moderation-warning", "Access temporarily restricted."); socket.disconnect(true); return; }
    socket.data.clientId = clientId;
    socket.data.blocked = Array.isArray(blocked)
      ? blocked.filter(x => typeof x === "string" && idPattern.test(x)).slice(0, 300)
      : [];
  });

  socket.on("report-user", ({ reason } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const recent = recentPartners.get(socket.id);
    if (!recent || Date.now() - recent.at > 120000 || !allowedReasons.has(reason)) {
      return reply({ ok: false, error: "No recent partner or invalid reason." });
    }
    if (rateLimited(reportTimes, socket.id, 3, 3600000)) {
      return reply({ ok: false, error: "Report limit reached. Please try later." });
    }
    const target = io.sockets.sockets.get(recent.id);
    const report = { time: new Date().toISOString(), reason, reporter: socket.id, reported: recent.id, reportedClientId: target?.data.clientId || null };
    pool.query(`INSERT INTO moderation_reports (time, reason, reporter, reported, reported_client_id)
      VALUES ($1, $2, $3, $4, $5)`,
      [report.time, report.reason, report.reporter, report.reported, report.reportedClientId])
      .then(() => {
        reports.push(report);
        if (reports.length > 500) reports.shift();
        console.log("MODERATION_REPORT", JSON.stringify(report));
        reply({ ok: true });
      }).catch(error => { console.error("REPORT_DB_ERROR", error); reply({ ok: false, error: "Could not save report. Try again." }); });
  });

  socket.on("block-user", ({ targetId } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const recent = recentPartners.get(socket.id);
    if (!recent || recent.id !== targetId || Date.now() - recent.at > 120000) {
      return reply({ ok: false });
    }
    const other = io.sockets.sockets.get(targetId);
    if (!other || !socket.data.clientId || !other.data.clientId) return reply({ ok: false });
    const key = pairKey(socket.data.clientId, other.data.clientId);
    pool.query(`INSERT INTO moderation_blocks (pair_key) VALUES ($1) ON CONFLICT DO NOTHING`, [key])
      .then(() => {
        blockedPairs.add(key);
        socket.data.blocked.push(other.data.clientId);
        reply({ ok: true, blockedId: other.data.clientId });
        leavePartner(socket);
        if (socket.data.ready) findPartner(socket);
      }).catch(error => { console.error("BLOCK_DB_ERROR", error); reply({ ok: false }); });
  });

  socket.on("find-partner", () => {
    if (!socket.data.clientId || (bannedIds.get(socket.data.clientId) || 0) > Date.now()) return;
    socket.data.ready = true;
    findPartner(socket);
  });

  socket.on("next", () => {
    if (rateLimited(skipTimes, socket.id, 25, 60000)) {
      socket.emit("moderation-warning", "Too many skips. Please wait a minute.");
      return;
    }
    leavePartner(socket);
    socket.data.ready = true;
    findPartner(socket);
  });

  socket.on("stop", () => {
    socket.data.ready = false;
    leavePartner(socket);
  });

  // Forward WebRTC messages between matched users
  socket.on("signal", (message) => {
    if (!message || typeof message !== "object") return;

    const { to, data } = message;

    if (partners.get(socket.id) !== to) return;

    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    socket.data.ready = false;
    leavePartner(socket);
    removeWaiting(socket.id);
    recentPartners.delete(socket.id);
    reportTimes.delete(socket.id);
    skipTimes.delete(socket.id);

    console.log("User disconnected:", socket.id);
  });
});


 // Start server
const PORT = process.env.PORT || 8000;

initializeDatabase().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("RandomChat server running with PostgreSQL on port", PORT);
  });
}).catch(error => {
  console.error("DATABASE_STARTUP_ERROR", error);
  process.exit(1);
});

