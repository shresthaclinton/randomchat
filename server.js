
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

    console.log("Matched:", socket.id, otherId);
    return;
  }

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

  socket.on("find-partner", () => {
    socket.data.ready = true;
    findPartner(socket);
  });

  socket.on("next", () => {
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

    console.log("User disconnected:", socket.id);
  });
});

// Start server
server.listen(8000, "127.0.0.1", () => {
  console.log("----------------------------------");
  console.log("RandomChat server is running!");
  console.log("http://127.0.0.1:8000");
  console.log("----------------------------------");
});
