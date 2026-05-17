const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 10e6, // 10 MB for file uploads
});

// ─── Gemini AI setup ───
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let genAI = null;
let geminiModel = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  console.log('[Qeets Bot] Gemini AI aktif ✓');
} else {
  console.warn('[Qeets Bot] GEMINI_API_KEY tidak diset — bot nonaktif');
}

// ─── File upload setup ───
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpe?g|png|gif|webp|svg|pdf|txt|md|json|csv|zip|docx?|xlsx?|pptx?)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan'));
  },
});

const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── File upload endpoint ───
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

app.get('*', (_, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ─── In-memory state ───
const rooms     = {};   // { [code]: { name, code, createdAt, createdBy, isPrivate } }
const members   = {};   // { [code]: { [socketId]: { name, color, id } } }
const messages  = {};   // { [code]: [...msgObjects] }
const reactions = {};   // { [code]: { [msgId]: { [emoji]: Set<name> } } }

const MAX_MSGS = 100;
const BOT_NAME  = 'Qeets';
const BOT_COLOR = '#00e5a0';

function getRoomList() {
  return Object.values(rooms)
    .filter(r => !r.isPrivate)
    .map(r => ({
      ...r,
      memberCount: Object.keys(members[r.code] || {}).length,
    }));
}

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

// ─── Gemini bot responder ───
async function handleBotMention(code, userMsg, userName) {
  if (!geminiModel) {
    sendBotMessage(code, '⚠️ Bot tidak aktif — GEMINI_API_KEY belum diset.');
    return;
  }

  // Strip @Qeets trigger from the message
  const query = userMsg.replace(/@Qeets\b/gi, '').trim();
  if (!query) {
    sendBotMessage(code, `Hai ${userName}! Tanya apa aja ke aku, ketik @Qeets <pertanyaanmu> 😊`);
    return;
  }

  // Show typing indicator from bot
  io.to(code).emit('bot_typing', { typing: true });

  try {
    // Build context from recent messages
    const history = (messages[code] || []).slice(-10)
      .filter(m => m.name !== BOT_NAME)
      .map(m => `${m.name}: ${m.text}`)
      .join('\n');

    const prompt = `Kamu adalah Qeets, asisten AI yang ramah dan helpful di sebuah platform chat bernama Qeets. Kamu membantu user dengan pertanyaan apapun, terutama seputar coding, teknologi, dan diskusi umum. Jawab dalam bahasa yang sama dengan pertanyaan user (Indonesia atau Inggris). Jawab dengan singkat, informatif, dan friendly.

Konteks chat terakhir:
${history}

${userName} bertanya: ${query}`;

    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text();
    sendBotMessage(code, text, userName);
  } catch (err) {
    console.error('[Gemini error]', err.message);
    sendBotMessage(code, `Maaf ${userName}, aku sedang tidak bisa menjawab sekarang. Coba lagi nanti ya! 🙏`);
  } finally {
    io.to(code).emit('bot_typing', { typing: false });
  }
}

function sendBotMessage(code, text, replyToName) {
  if (!rooms[code]) return;
  const msg = {
    id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: BOT_NAME,
    color: BOT_COLOR,
    text,
    isCode: false,
    isBot: true,
    replyTo: null,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(),
  };
  if (!messages[code]) messages[code] = [];
  messages[code].push(msg);
  if (messages[code].length > MAX_MSGS) messages[code].shift();
  io.to(code).emit('new_msg', msg);
}

// ─── Socket.IO ───
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

    const history = (messages[upperCode] || []).map(m => ({ ...m }));
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
    socket.emit('room_meta', { code: upperCode, name: rooms[upperCode].name, isPrivate: rooms[upperCode].isPrivate });

    // Send rooms list
    const listForSocket = getRoomList();
    if (rooms[upperCode].isPrivate) {
      listForSocket.push({
        ...rooms[upperCode],
        memberCount: Object.keys(members[upperCode] || {}).length,
      });
    }
    socket.emit('rooms_list', listForSocket);
    socket.broadcast.emit('rooms_list', getRoomList());
    console.log(`[join] ${name} → #${upperCode}`);
  });

  // ── Send message ──
  socket.on('send_msg', ({ text, isCode, replyTo, fileData }) => {
    const { name, color, code } = socket.data || {};
    if (!code || !rooms[code]) return;

    const msg = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name, color, text,
      isCode: !!isCode,
      isBot: false,
      fileData: fileData || null,  // { url, name, size, mime }
      replyTo: replyTo || null,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(),
    };

    if (!messages[code]) messages[code] = [];
    messages[code].push(msg);
    if (messages[code].length > MAX_MSGS) messages[code].shift();

    io.to(code).emit('new_msg', msg);

    // Check @Qeets trigger
    if (text && /@Qeets\b/i.test(text)) {
      handleBotMention(code, text, name);
    }

    // Send mention notifications to tagged users (info only via system)
    const mentionMatches = text ? [...text.matchAll(/@([A-Za-z0-9_\u00C0-\u024F]+)/g)] : [];
    const mentioned = mentionMatches
      .map(m => m[1].toLowerCase())
      .filter(n => n !== 'qeets');
    
    if (mentioned.length) {
      // Find socket IDs of mentioned users and send them a special event
      Object.entries(members[code]).forEach(([sid, member]) => {
        if (mentioned.includes(member.name.toLowerCase()) && sid !== socket.id) {
          io.to(sid).emit('you_were_mentioned', { by: name, msgId: msg.id, preview: text.slice(0, 80) });
        }
      });
    }
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

  // ── Typing ──
  socket.on('typing', () => {
    const { name, color, code } = socket.data || {};
    if (!code) return;
    socket.to(code).emit('user_typing', { name, color });
  });

  socket.on('stop_typing', () => {
    const { name, code } = socket.data || {};
    if (!code) return;
    socket.to(code).emit('user_stop_typing', { name });
  });

  // ── Get member list (for @mention autocomplete) ──
  socket.on('get_members', () => {
    const { code } = socket.data || {};
    if (!code || !members[code]) return;
    socket.emit('members', Object.values(members[code]));
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
    setTimeout(() => cleanupRoomIfEmpty(code), 1500);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Qeets running on port ${PORT}`));