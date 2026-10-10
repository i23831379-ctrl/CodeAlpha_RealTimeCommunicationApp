// Real‑time communication server with room support
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'client', 'dist')));

// Explicit root route for SPA entry point
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// In‑memory map: roomId → { users: Map<socketId, {username}> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { users: new Map() });
  return rooms.get(roomId);
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  // ---------- Join a room ----------
  socket.on('join-room', ({ roomId, username }) => {
    const room = getRoom(roomId);
    room.users.set(socket.id, { username });
    socket.join(roomId);
    console.log(`${username} joined room ${roomId}`);

    // Notify existing participants
    socket.to(roomId).emit('user-joined', { socketId: socket.id, username });

    // Send current participant list to the newcomer
    const participants = Array.from(room.users.entries()).map(([id, data]) => ({ socketId: id, username: data.username }));
    socket.emit('room-users', participants);
  });

  // ---------- Chat ----------
  socket.on('chat', data => {
    // data: { text, sender }
    const roomsOfSocket = Array.from(socket.rooms).filter(r => r !== socket.id);
    roomsOfSocket.forEach(roomId => {
      socket.to(roomId).emit('chat', data);
    });
  });

  // ---------- Typing indicator ----------
  socket.on('typing', ({ roomId, username, typing }) => {
    socket.to(roomId).emit('typing', { socketId: socket.id, username, typing });
  });

  // ---------- Signalling (WebRTC) ----------
  socket.on('signal', ({ target, description, candidate, roomId }) => {
    // If a target socket is specified, send directly; otherwise broadcast within room
    if (target) {
      io.to(target).emit('signal', { from: socket.id, description, candidate });
    } else if (roomId) {
      socket.to(roomId).emit('signal', { from: socket.id, description, candidate });
    }
  });

  // ---------- Whiteboard ----------
  socket.on('draw', payload => {
    const roomsOfSocket = Array.from(socket.rooms).filter(r => r !== socket.id);
    roomsOfSocket.forEach(roomId => socket.to(roomId).emit('draw', payload));
  });

  socket.on('clear', () => {
    const roomsOfSocket = Array.from(socket.rooms).filter(r => r !== socket.id);
    roomsOfSocket.forEach(roomId => socket.to(roomId).emit('clear'));
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Remove socket from any rooms it was part of
    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        const { username } = room.users.get(socket.id);
        room.users.delete(socket.id);
        socket.to(roomId).emit('user-left', { socketId: socket.id, username });
        // Clean up empty rooms
        if (room.users.size === 0) rooms.delete(roomId);
      }
    });
  });
});

const PORT = process.env.PORT || 4002;

// Start the server on the configured port.
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// SPA fallback: serve index.html for any unknown route (helps client‑side routing)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
});
