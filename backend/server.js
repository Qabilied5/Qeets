const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT));
app.get('*', (_, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ─── In-memory state ───
const rooms    = {};   // { [code]: { name, code, createdAt, createdBy } }
const members  = {};   // { [code]: { [socketId]: { name, color, id } } }
const messages = {};   // { [code]: [...msgObjects] }
const reactions = {};  // { [code]: { [msgId]: { [emoji]: Set<name> } } }

const MAX_MSGS = 100;

function getRoomList() {
  // Only return PUBLIC rooms
  return Object.values(rooms)
    .filter(r => !r.isPrivate)
    .map(r => ({
      ...r,
      memberCount: Object.keys(members[r.code] || {}).length,
    }));
}

// Delete room + all its data if empty
function cleanupRoomIfEmpty(code) {
  if (!rooms[code]) return;
  const count = Object.keys(members[code] || {}).length;
  if (count === 0) {
    console.log(`[cleanup] Room #${code} kosong — dihapus`);
    delete rooms[code];
    delete members[code];
    delete messages[code];
    delete reactions[code];
    io.emit('rooms_list', getRoomList());
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('get_rooms', () => socket.emit('rooms_list', getRoomList()));

  // ── Create room ──
  socket.on('create_room', ({ name, roomName, color, isPrivate }) => {
    const code = generateCode();
    rooms[code]     = { name: roomName, code, createdAt: Date.now(), createdBy: socket.id, isPrivate: !!isPrivate };
    members[code]   = {};
    messages[code]  = [];
    reactions[code] = {};
    socket.emit('room_created', { code, roomName, isPrivate: !!isPrivate });
    io.emit('rooms_list', getRoomList());
  });

  // ── Join room ──
  socket.on('join_room', ({ code, name, color }) => {
    const upperCode = code.toUpperCase();
    if (!rooms[upperCode]) { socket.emit('error_msg', 'Room tidak ditemukan.'); return; }

    [...socket.rooms].filter(r => r !== socket.id).forEach(r => socket.leave(r));
    socket.join(upperCode);
    socket.data = { name, color, code: upperCode };

    if (!members[upperCode]) members[upperCode] = {};
    members[upperCode][socket.id] = { name, color, id: socket.id };

    // Attach reaction counts to history messages
    const history = (messages[upperCode] || []).map(m => ({
      ...m,
      // reactions sent separately via reaction_update
    }));
    socket.emit('history', history);

    // Send current reactions
    const roomReacts = reactions[upperCode] || {};
    Object.entries(roomReacts).forEach(([msgId, emojiMap]) => {
      Object.entries(emojiMap).forEach(([emoji, namesSet]) => {
        [...namesSet].forEach(n => {
          socket.emit('reaction_update', { msgId, emoji, name: n, action: 'add' });
        });
      });
    });

    io.to(upperCode).emit('members', Object.values(members[upperCode]));
    socket.to(upperCode).emit('user_joined', { name, color });
    // Send room meta (incl. isPrivate) to the joining socket
    socket.emit('room_meta', { code: upperCode, name: rooms[upperCode].name, isPrivate: rooms[upperCode].isPrivate });
    // For sidebar: send public list + the joined room itself (in case it's private)
    const listForSocket = getRoomList();
    if (rooms[upperCode].isPrivate) {
      listForSocket.push({
        ...rooms[upperCode],
        memberCount: Object.keys(members[upperCode] || {}).length,
      });
    }
    socket.emit('rooms_list', listForSocket);
    // Broadcast public list to everyone else
    socket.broadcast.emit('rooms_list', getRoomList());
    console.log(`[join] ${name} → #${upperCode}`);
  });

  // ── Send message ──
  socket.on('send_msg', ({ text, isCode, replyTo }) => {
    const { name, color, code } = socket.data || {};
    if (!code || !rooms[code]) return;

    const msg = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name, color, text,
      isCode: !!isCode,
      replyTo: replyTo || null,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(),
    };

    if (!messages[code]) messages[code] = [];
    messages[code].push(msg);
    if (messages[code].length > MAX_MSGS) messages[code].shift();

    io.to(code).emit('new_msg', msg);
  });

  // ── Reactions ──
  socket.on('reaction', ({ msgId, emoji, action }) => {
    const { name, code } = socket.data || {};
    if (!code || !rooms[code]) return;

    if (!reactions[code]) reactions[code] = {};
    if (!reactions[code][msgId]) reactions[code][msgId] = {};
    if (!reactions[code][msgId][emoji]) reactions[code][msgId][emoji] = new Set();

    const set = reactions[code][msgId][emoji];
    if (action === 'add')    set.add(name);
    if (action === 'remove') set.delete(name);
    if (set.size === 0) delete reactions[code][msgId][emoji];

    io.to(code).emit('reaction_update', { msgId, emoji, name, action });
  });

  // ── Typing ── (now sends name so clients can track per-user)
  socket.on('typing', () => {
    const { name, color, code } = socket.data || {};
    if (!code) return;
    socket.to(code).emit('user_typing', { name, color });
  });

  socket.on('stop_typing', () => {
    const { name, code } = socket.data || {};
    if (!code) return;
    // Send name so client can clear just that user
    socket.to(code).emit('user_stop_typing', { name });
  });

  // ── Leave room ──
  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => { handleLeave(socket); console.log(`[disconnect] ${socket.id}`); });

  function handleLeave(socket) {
    const { name, code } = socket.data || {};
    if (!code || !members[code]) return;
    delete members[code][socket.id];
    socket.leave(code);
    io.to(code).emit('members', Object.values(members[code]));
    socket.to(code).emit('user_left', { name });
    socket.data = {};
    // Delay cleanup slightly so disconnect flood doesn't race
    setTimeout(() => cleanupRoomIfEmpty(code), 1500);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`DevRoom running on port ${PORT}`));