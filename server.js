
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Server } = require("socket.io");

// Create the website server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Socket.IO requests are handled automatically
  // by the Socket.IO server attached below.

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
    const report = { time: new Date().toISOString(), reason, reporter: socket.id, reported: recent.id };
    reports.push(report);
    if (reports.length > 500) reports.shift();
    console.log("MODERATION_REPORT", JSON.stringify(report));
    reply({ ok: true });
  });

  socket.on("block-user", ({ targetId } = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const recent = recentPartners.get(socket.id);
    if (!recent || recent.id !== targetId || Date.now() - recent.at > 120000) {
      return reply({ ok: false });
    }
    const other = io.sockets.sockets.get(targetId);
    if (!other || !socket.data.clientId || !other.data.clientId) return reply({ ok: false });
    blockedPairs.add(pairKey(socket.data.clientId, other.data.clientId));
    socket.data.blocked.push(other.data.clientId);
    reply({ ok: true, blockedId: other.data.clientId });
    leavePartner(socket);
    if (socket.data.ready) findPartner(socket);
  });

  socket.on("find-partner", () => {
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------");
  console.log("RandomChat server is running!");
  console.log(`Port: ${PORT}`);
  console.log("----------------------------------");
});

