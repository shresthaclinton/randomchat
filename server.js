const http = require("node:http");
const https = require("node:https");
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
  await pool.query(`ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS reporter_client_id TEXT`);
  await pool.query(`ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS description TEXT`);
  await pool.query(`ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_bans (
    client_id TEXT PRIMARY KEY, until_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_blocks (
    pair_key TEXT PRIMARY KEY)`);
  const [savedReports, savedBans, savedBlocks] = await Promise.all([
    pool.query(`SELECT id, time, reason, reporter, reported, reported_client_id, reporter_client_id, description, status FROM moderation_reports ORDER BY id DESC LIMIT 500`),
    pool.query(`SELECT client_id, until_at FROM moderation_bans WHERE until_at > NOW()`),
    pool.query(`SELECT pair_key FROM moderation_blocks`)
  ]);
  reports.push(...savedReports.rows.reverse().map(r => ({
    id: String(r.id), time: r.time.toISOString(), reason: r.reason, reporter: r.reporter, reporterClientId: r.reporter_client_id, description: r.description || "", status: r.status,
    reported: r.reported, reportedClientId: r.reported_client_id
  })));
  for (const r of savedBans.rows) bannedIds.set(r.client_id, new Date(r.until_at).getTime());
  for (const r of savedBlocks.rows) blockedPairs.add(r.pair_key);
  await pool.query(`DELETE FROM moderation_bans WHERE until_at <= NOW()`);
  console.log("PostgreSQL moderation data loaded");
}


// Fetch credential-scoped ICE settings on the server, never commit the Metered API key.
const fallbackIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let iceCache = null;
let iceCacheUntil = 0;
function fetchMeteredIce() {
  return new Promise((resolve, reject) => {
    const key = process.env.METERED_API_KEY;
    if (!key) return reject(new Error("METERED_API_KEY missing"));
    const endpoint = new URL("https://randomchat-nepal.metered.live/api/v1/turn/credentials");
    endpoint.searchParams.set("apiKey", key);
    const request = https.get(endpoint, { timeout: 4500 }, response => {
      let body = "";
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 32768) response.destroy(new Error("ICE response too large"));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error("Metered HTTP " + response.statusCode));
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data) || data.length > 16 || !data.every(item =>
            item && (typeof item.urls === "string" || Array.isArray(item.urls)) &&
            [item.urls].flat().every(u => typeof u === "string" && /^(stun|stuns|turn|turns):/.test(u)) &&
            (!item.username || typeof item.username === "string") &&
            (!item.credential || typeof item.credential === "string")
          )) throw new Error("Invalid ICE response");
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Metered timeout")));
    request.on("error", reject);
  });
}

// Create the website server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // Serve only the packaged NPL PNG assets. Do not expose arbitrary files.
  if (req.method === "GET" && /^\/assets\/npl\/[a-z0-9-]+\.png$/.test(url.pathname)) {
    const fileName = url.pathname.slice("/assets/npl/".length);
    const assetPath = path.join(__dirname, "assets", "npl", fileName);
    fs.stat(assetPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Image not found"); return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff"
      });
      fs.createReadStream(assetPath).pipe(res);
    });
    return;
  }


  // Socket.IO requests are handled automatically
  // by the Socket.IO server attached below.

  if (url.pathname === "/api/ice-servers" && req.method === "GET") {
    const respond = (iceServers, enabled) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify({ iceServers, turnAvailable: enabled }));
    };
    if (!process.env.METERED_API_KEY) { respond(fallbackIceServers, false); return; }
    if (iceCache && Date.now() < iceCacheUntil) { respond(iceCache, true); return; }
    fetchMeteredIce().then(ice => {
      iceCache = ice;
      iceCacheUntil = Date.now() + 60_000;
      respond(ice, true);
    }).catch(error => {
      console.warn("TURN_ICE_FETCH_FAILED", error.message);
      respond(fallbackIceServers, false);
    });
    return;
  }

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
      const activeChatSeconds = [...chatStarts.values()].reduce((sum, start) => sum + Math.max(0, Math.round((now - start) / 1000)), 0);
      const payload = { ok: true, monitor: { ...monitor, activeChatSeconds, totalChatSeconds: monitor.completedChatSeconds + activeChatSeconds, estimatedAverageChatSeconds: monitor.matches ? Math.round((monitor.completedChatSeconds + activeChatSeconds) / monitor.matches) : 0, scope: "Current server process only; resets on restart", turnBytes: null }, online: io.engine.clientsCount, waiting: waiting.filter(id => io.sockets.sockets.has(id)).length, activeChats: partners.size / 2, reports: reports.slice(-100).reverse().map(r => ({...r, uniqueReporters: new Set(reports.filter(x => x.reportedClientId && x.reportedClientId === r.reportedClientId && x.reporterClientId).map(x => x.reporterClientId)).size || (r.reporterClientId ? 1 : null)})), bans: [...bannedIds].map(([clientId, until]) => ({ clientId, until: new Date(until).toISOString() })) };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === "/api/admin/report-status" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
      req.on("end", async () => {
        let input;
        try { input = JSON.parse(body); } catch { input = {}; }
        if (!/^[0-9]+$/.test(String(input.id || "")) || !["pending", "dismissed", "confirmed"].includes(input.status)) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Invalid report or status" })); return;
        }
        try {
          const result = await pool.query("UPDATE moderation_reports SET status = $1 WHERE id = $2 RETURNING id", [input.status, input.id]);
          if (!result.rowCount) { res.writeHead(404); res.end("Report not found"); return; }
          for (const r of reports) if (r.id === String(input.id)) r.status = input.status;
          console.log("ADMIN_REPORT_REVIEW", JSON.stringify({ id: input.id, status: input.status }));
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ok: true }));
        } catch (error) { console.error("REPORT_REVIEW_DB_ERROR", error); res.writeHead(503); res.end("Database unavailable"); }
      });
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
  const policyPages = { "/privacy": "privacy.html", "/terms": "terms.html", "/guidelines": "guidelines.html" };
  if (req.method === "GET" && policyPages[url.pathname]) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(path.join(__dirname, policyPages[url.pathname])).pipe(res);
    return;
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

// V4: transient game state, scoped to the currently matched pair.
const games = new Map();
const reactionTimes = new Map();
const textTimes = new Map();
// Original text-only supporter labels. No official team logos are distributed.
const supporterTeams = new Set(["", "Biratnagar Kings", "Chitwan Rhinos", "Janakpur Bolts", "Kathmandu Gurkhas", "Karnali Yaks", "Lumbini Lions", "Pokhara Avengers", "Sudurpaschim Royals"]);
const positiveReactions = new Set(["❤️","😂","👏","🎉","🙌","👍","✨"]);
const winningLines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function gamePair(socket) {
  const other = partners.get(socket.id);
  return other ? {other,key:pairKey(socket.id,other)} : null;
}
const wouldRatherQuestions=[
 {q:"Would you rather explore the mountains or the ocean?",options:["Mountains","Ocean"]},
 {q:"Would you rather travel to the past or the future?",options:["Past","Future"]},
 {q:"Would you rather have unlimited books or unlimited movies?",options:["Books","Movies"]},
 {q:"Would you rather fly or become invisible?",options:["Fly","Invisible"]},
 {q:"Would you rather live in a big city or a quiet village?",options:["Big city","Quiet village"]},
 {q:"Would you rather speak every language or play every instrument?",options:["Every language","Every instrument"]},
 {q:"Would you rather always have summer or always have winter?",options:["Summer","Winter"]},
 {q:"Would you rather explore space or the deep sea?",options:["Space","Deep sea"]}
];
function sendExtraGameState(key,g){
 const ids=[g.inviter,g.invitee],finished=ids.every(id=>Object.hasOwn(g.choices,id));
 for(const id of ids){
  const other=id===g.inviter?g.invitee:g.inviter;
  const base={type:g.type,finished,chosen:Object.hasOwn(g.choices,id)};
  if(g.type==="rps"){
   base.you=id===g.inviter?"A":"B";
   if(finished){
    const a=g.choices[id],b=g.choices[other];
    base.yourChoice=a;base.theirChoice=b;
    base.result=a===b?"draw":({rock:"scissors",paper:"rock",scissors:"paper"}[a]===b?base.you:"other");
   }
  }else{
   const q=wouldRatherQuestions[g.questionIndex%wouldRatherQuestions.length];
   base.question=q.q;base.options=q.options;
   if(finished){base.yourChoice=q.options[g.choices[id]];base.theirChoice=q.options[g.choices[other]];}
  }
  io.to(id).emit("galli-extra-game-state",base);
 }
}
function clearGame(socket) {
  const pair=gamePair(socket);
  if(pair) {games.delete(pair.key);io.to(pair.other).emit("galli-game-ended");}
}

// Lightweight process-lifetime metrics. Reset whenever Render restarts.
const monitor = { startedAt: new Date().toISOString(), connections: 0, matches: 0, completedChatSeconds: 0, longestChatSeconds: 0 };
const chatStarts = new Map();
function closeChatTimer(a, b) {
  const key = pairKey(a, b);
  const started = chatStarts.get(key);
  if (started === undefined) return;
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  monitor.completedChatSeconds += seconds;
  monitor.longestChatSeconds = Math.max(monitor.longestChatSeconds, seconds);
  chatStarts.delete(key);
}

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

    if (!eligible(socket, other)) {
      // Diagnose blocked matches without logging persistent browser IDs.
      const a = socket.data.clientId, b = other.data.clientId;
      const reason = !a || !b ? "missing-identity" :
        ((bannedIds.get(a) || 0) > Date.now() || (bannedIds.get(b) || 0) > Date.now()) ? "banned" :
        blockedPairs.has(pairKey(a, b)) ? "persistent-block" :
        (socket.data.blocked || []).includes(b) || (other.data.blocked || []).includes(a) ? "browser-block" : "other";
      console.info("MATCH_INELIGIBLE", { reason, socket: socket.id, other: otherId });
      deferred.push(otherId);
      continue;
    }
    waiting.push(...deferred);
    partners.set(socket.id, otherId);
    partners.set(otherId, socket.id);
    monitor.matches++;
    chatStarts.set(pairKey(socket.id, otherId), Date.now());

    socket.emit("matched", {
      partnerId: otherId,
      initiator: true
    });

    other.emit("matched", {
      partnerId: socket.id,
      initiator: false
    });
    socket.emit("galli-badge-peer", {team: other.data.supporterTeam || ""});
    other.emit("galli-badge-peer", {team: socket.data.supporterTeam || ""});

    recentPartners.set(socket.id, { id: otherId, at: Date.now() });
    recentPartners.set(otherId, { id: socket.id, at: Date.now() });
    console.log("Matched:", socket.id, otherId);
    return;
  }

  waiting.push(...deferred);
  waiting.push(socket.id);
  console.info("MATCH_WAITING", { socket: socket.id, waitingCount: waiting.length, identified: !!socket.data.clientId });
  socket.emit("waiting");
}

function leavePartner(socket) {
  removeWaiting(socket.id);

  const otherId = partners.get(socket.id);

  if (!otherId) return;

  closeChatTimer(socket.id, otherId);
  clearGame(socket);
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
  monitor.connections++;
  console.log("User connected:", socket.id);

  socket.data.ready = false;
  socket.data.clientId = null;
  socket.data.blocked = [];
  socket.data.supporterTeam = "";
  socket.on("identify", ({ clientId, blocked } = {}) => {
    if (typeof clientId !== "string" || !idPattern.test(clientId)) return;
    if ((bannedIds.get(clientId) || 0) > Date.now()) { socket.emit("moderation-warning", "Access temporarily restricted."); socket.disconnect(true); return; }
    socket.data.clientId = clientId;
    socket.data.blocked = Array.isArray(blocked)
      ? blocked.filter(x => typeof x === "string" && idPattern.test(x)).slice(0, 300)
      : [];
    // If a request arrived before identification, retry matchmaking now.
    if (socket.data.ready && !partners.has(socket.id)) findPartner(socket);
  });

  socket.on("report-user", ({ reason, description } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const recent = recentPartners.get(socket.id);
    if (!recent || Date.now() - recent.at > 120000 || !allowedReasons.has(reason)) {
      return reply({ ok: false, error: "No recent partner or invalid reason." });
    }
    if (rateLimited(reportTimes, socket.id, 3, 3600000)) {
      return reply({ ok: false, error: "Report limit reached. Please try later." });
    }
    const target = io.sockets.sockets.get(recent.id);
    const cleanDescription = typeof description === "string" ? description.trim().slice(0, 500) : "";
    const report = { time: new Date().toISOString(), reason, reporter: socket.id, reporterClientId: socket.data.clientId, reported: recent.id, reportedClientId: target?.data.clientId || null, description: cleanDescription, status: "pending" };
    pool.query(`INSERT INTO moderation_reports (time, reason, reporter, reported, reported_client_id, reporter_client_id, description, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [report.time, report.reason, report.reporter, report.reported, report.reportedClientId, report.reporterClientId, report.description, report.status])
      .then(result => {
        report.id = String(result.rows[0].id);
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
    if (!socket.data.clientId) {
      console.warn("MATCH_WAITING_FOR_IDENTIFY", { socket: socket.id });
      socket.data.ready = true;
      return;
    }
    if ((bannedIds.get(socket.data.clientId) || 0) > Date.now()) {
      socket.emit("moderation-warning", "Access temporarily restricted.");
      return;
    }
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


  socket.on("galli-game-invite", ({type="ttt"}={}) => {
    if(!["ttt","rps","wyr"].includes(type))return;
    const p=gamePair(socket);
    if(!p) return;
    const old=games.get(p.key);
    if(old) return;
    games.set(p.key,{status:"pending",type,inviter:socket.id,invitee:p.other});
    io.to(p.other).emit("galli-game-invite",{type});
    socket.emit("galli-game-pending");
  });
  socket.on("galli-game-response", ({accept}={}) => {
    const p=gamePair(socket);if(!p)return;
    const g=games.get(p.key);
    if(!g||g.status!=="pending"||g.invitee!==socket.id)return;
    if(accept!==true) {
      games.delete(p.key);
      io.to(g.inviter).emit("galli-game-declined");
      return;
    }
    g.status="playing";
    if(g.type!=="ttt"){
      g.choices={};g.round=0;g.questionIndex=0;
      sendExtraGameState(p.key,g);
      return;
    }
    g.status="playing";g.board=Array(9).fill(null);g.turn="X";g.players={[g.inviter]:"X",[g.invitee]:"O"};g.winner=null;g.draw=false;
    io.to(g.inviter).emit("galli-game-state",{board:g.board,turn:g.turn,you:"X",winner:null,draw:false});
    socket.emit("galli-game-state",{board:g.board,turn:g.turn,you:"O",winner:null,draw:false});
  });
  socket.on("galli-game-play-again", () => {
    const p=gamePair(socket);if(!p)return;
    const g=games.get(p.key);
    // A replay is allowed only after the current match has finished.
    if(!g || g.status!=="playing" || (g.type==="ttt" ? (!g.winner && !g.draw) : Object.keys(g.choices||{}).length!==2))return;
    if(g.type!=="ttt"){
      g.choices={};g.round=(g.round||0)+1;
      if(g.type==="wyr")g.questionIndex=(g.questionIndex+1)%wouldRatherQuestions.length;
      sendExtraGameState(p.key,g);return;
    }
    g.board=Array(9).fill(null);g.turn="X";g.winner=null;g.draw=false;
    for(const id of [socket.id,p.other]) {
      io.to(id).emit("galli-game-state",{board:g.board,turn:g.turn,you:g.players[id],winner:null,draw:false});
    }
  });
  socket.on("galli-game-move", ({index}={}) => {
    const p=gamePair(socket);if(!p)return;
    const g=games.get(p.key);
    if(!g||g.type!=="ttt"||g.status!=="playing"||!Number.isInteger(index)||index<0||index>8||g.board[index]||g.winner||g.draw||g.players[socket.id]!==g.turn)return;
    g.board[index]=g.turn;
    if(winningLines.some(line=>line.every(i=>g.board[i]===g.turn)))g.winner=g.turn;
    else if(g.board.every(Boolean))g.draw=true;
    else g.turn=g.turn==="X"?"O":"X";
    for(const id of [socket.id,p.other])io.to(id).emit("galli-game-state",{board:g.board,turn:g.turn,you:g.players[id],winner:g.winner,draw:g.draw});
  });
  socket.on("galli-extra-game-choice", ({choice}={}) => {
    const p=gamePair(socket);if(!p)return;
    const g=games.get(p.key);
    if(!g||g.status!=="playing"||!["rps","wyr"].includes(g.type)||Object.hasOwn(g.choices,socket.id))return;
    if(g.type==="rps" && !["rock","paper","scissors"].includes(choice))return;
    if(g.type==="wyr" && ![0,1].includes(choice))return;
    g.choices[socket.id]=choice;
    sendExtraGameState(p.key,g);
  });
  socket.on("galli-game-close", () => {
    const p=gamePair(socket);if(!p)return;
    games.delete(p.key);io.to(p.other).emit("galli-game-ended");
  });
  socket.on("galli-text", ({message}={}) => {
    const p=gamePair(socket);
    if(!p || typeof message!=="string")return;
    const clean=message.trim();
    if(!clean || clean.length>500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(clean))return;
    if(rateLimited(textTimes,socket.id,12,10000)){
      socket.emit("galli-text-warning", "Please slow down before sending more messages.");return;
    }
    io.to(p.other).emit("galli-text", {message:clean});
    socket.emit("galli-text-sent", {message:clean});
  });
  socket.on("galli-badge-select", ({team}={}) => {
    if(typeof team!=="string" || !supporterTeams.has(team))return;
    socket.data.supporterTeam=team;
    const p=gamePair(socket);
    if(p)io.to(p.other).emit("galli-badge-peer",{team});
  });
  socket.on("galli-reaction", ({emoji}={}) => {
    const p=gamePair(socket);
    if(!p||!positiveReactions.has(emoji)||rateLimited(reactionTimes,socket.id,6,10000))return;
    io.to(p.other).emit("galli-reaction",{emoji});
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
    reactionTimes.delete(socket.id);
    textTimes.delete(socket.id);

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
