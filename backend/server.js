const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 100e6, // 100 MB for video uploads
});

// ─── Gemini AI setup ───
const { GoogleGenerativeAI } = require('@google/generative-ai');

function makeGeminiModel(apiKey) {
  if (!apiKey) return null;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  } catch { return null; }
}

console.log('[Qeets Bot] Gemini AI siap — menunggu API key dari user');

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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB (for video)
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpe?g|png|gif|webp|svg|pdf|txt|md|json|csv|zip|docx?|xlsx?|pptx?|mp4|webm|mov|avi|mkv|mp3|ogg|wav|m4a|aac)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan'));
  },
});

const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT));
app.use('/uploads', express.static(UPLOADS_DIR));

// PWA icons
app.get('/icon-192.png', (_, res) => res.sendFile(path.join(ROOT, 'icon-192.png')));
app.get('/icon-512.png', (_, res) => res.sendFile(path.join(ROOT, 'icon-512.png')));

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
const games     = {};   // { [code]: { active, question, topic, answers: Map<name, answer>, expectedCount } }
const socketApiKeys = {}; // { [socketId]: apiKey } — per-socket Gemini API key from client

// function getModelForRoom(code) {
//   const roomMembers = members[code] || {};
//   for (const sid of Object.keys(roomMembers)) {
//     if (socketApiKeys[sid]) return makeGeminiModel(socketApiKeys[sid]);
//   }
//   return null; // no key available
// }

function getModelForRoom(code) {
  const roomMembers = members[code] || {};
  console.log('[getModelForRoom] members:', Object.keys(roomMembers));
  console.log('[getModelForRoom] socketApiKeys:', Object.keys(socketApiKeys));
  for (const sid of Object.keys(roomMembers)) {
    if (socketApiKeys[sid]) {
      console.log('[getModelForRoom] found key for sid:', sid);
      return makeGeminiModel(socketApiKeys[sid]);
    }
  }
  console.log('[getModelForRoom] NO KEY FOUND');
  return null;
}

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
    delete games[code];
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

// ─── GAME MODE ───

const GAME_SYSTEM = `Kamu adalah Qeets, host kuis interaktif di chat. Tugasmu:
1. Buat pertanyaan kuis singkat dan menarik berdasarkan topik yang diminta.
2. Nilai jawaban para pemain dengan adil.
Format respons HARUS ringkas. Bahasa menyesuaikan bahasa user.`;

async function handleGameStart(code, text, userName) {
  const geminiModel = getModelForRoom(code);
  if (!geminiModel) {
    sendBotMessage(code, '⚠️ Bot tidak aktif — masukkan Gemini API Key di halaman lobby sebelum bergabung room.');
    return;
  }

  const topic = text.replace(/@Qeets\s+Game\b/gi, '').trim();
  if (!topic) {
    sendBotMessage(code, `Hei ${userName}! Sebutkan topiknya ya. Contoh: @Qeets Game Ibu Kota Negara`);
    return;
  }

  const memberCount = Object.keys(members[code] || {}).length;
  games[code] = { active: true, question: '', topic, answers: new Map(), expectedCount: memberCount };

  io.to(code).emit('bot_typing', { typing: true });
  try {
    const chat = geminiModel.startChat({ history: [], systemInstruction: GAME_SYSTEM });
    const result = await chat.sendMessage(
      `Buat 1 pertanyaan kuis singkat (maks 2 kalimat) tentang: "${topic}". Hanya tulis pertanyaannya saja, tanpa jawaban.`
    );
    const question = result.response.text().trim();
    games[code].question = question;

    const memberList = Object.values(members[code] || {}).map(m => m.name).join(', ');
    sendBotMessage(code,
      `🎮 **GAME DIMULAI!** Topik: ${topic}\n\n❓ ${question}\n\n` +
      `Jawab dengan mengetik: @Answer [jawaban kamu]\n` +
      `Menunggu ${memberCount} pemain: ${memberList}`
    );
    io.to(code).emit('game_started', { topic, question, expectedCount: memberCount });
  } catch (err) {
    console.error('[Game start error]', err.message);
    delete games[code];
    sendBotMessage(code, `Maaf ${userName}, gagal membuat pertanyaan. Coba lagi ya!`);
  } finally {
    io.to(code).emit('bot_typing', { typing: false });
  }
}

async function handleGameAnswer(code, text, userName) {
  const game = games[code];
  if (!game || !game.active) return false;

  const answer = text.replace(/@Answer\b/gi, '').trim();
  if (!answer) { sendBotMessage(code, `${userName}, jawaban tidak boleh kosong! Tulis: @Answer [jawabanmu]`); return true; }
  if (game.answers.has(userName)) {
    sendBotMessage(code, `${userName}, kamu sudah menjawab! Tunggu pemain lain ya.`);
    return true;
  }

  game.answers.set(userName, answer);
  const count = game.answers.size;
  const expected = game.expectedCount;

  io.to(code).emit('game_answer_in', { name: userName, count, expected });

  if (count < expected) {
    sendBotMessage(code, `✅ ${userName} sudah menjawab! (${count}/${expected}) Menunggu ${expected - count} pemain lagi…`);
  } else {
    // All answered — evaluate
    game.active = false;
    io.to(code).emit('bot_typing', { typing: true });
    try {
      const chat = geminiModel.startChat({ systemInstruction: GAME_SYSTEM });
      const answerList = [...game.answers.entries()].map(([n, a]) => `${n}: "${a}"`).join('\n');
      const result = await chat.sendMessage(
        `Pertanyaan: "${game.question}"\n\nJawaban pemain:\n${answerList}\n\nNilai setiap jawaban dengan format:\n[Nama]: ✅ Benar / ❌ Salah / 🟡 Hampir — (koreksi singkat jika perlu). Ringkas, maks 1 baris per orang. Akhiri dengan skor total.`
      );
      const verdict = result.response.text().trim();
      sendBotMessage(code, `🏆 **HASIL KUIS!**\n\n${verdict}\n\n_Ketik @Qeets Game [topik] untuk ronde baru!_`);
      io.to(code).emit('game_ended', { verdict });
    } catch (err) {
      console.error('[Game eval error]', err.message);
      sendBotMessage(code, `Maaf, gagal mengevaluasi jawaban. Coba mulai game baru!`);
    } finally {
      io.to(code).emit('bot_typing', { typing: false });
      delete games[code];
    }
  }
  return true;
}

// ─── Gemini bot responder ───

const SYSTEM_INSTRUCTION = `Kamu adalah Qeets, asisten AI yang ramah dan helpful di sebuah platform chat bernama Qeets. Kamu membantu user dengan pertanyaan apapun, terutama seputar coding, teknologi, dan diskusi umum. Jawab dalam bahasa yang sama dengan pertanyaan user (Indonesia atau Inggris). Jawab dengan singkat, to the point, informatif, dan friendly. Kamu sadar bahwa kamu sedang berada di dalam grup chat, jadi kamu tahu siapa yang sedang berbicara dengan kamu berdasarkan nama yang disebut.`;

// Build Gemini-format history from recent room messages
function buildChatHistory(code) {
  const roomMsgs = (messages[code] || []).slice(-30); // ambil 30 pesan terakhir
  const history = [];

  for (const m of roomMsgs) {
    const isBot = m.name === BOT_NAME;
    const role  = isBot ? 'model' : 'user';
    const text  = isBot ? m.text : `[${m.name}]: ${m.text}`;

    // Gemini requires alternating user/model turns — merge consecutive same-role messages
    if (history.length > 0 && history[history.length - 1].role === role) {
      history[history.length - 1].parts[0].text += '\n' + text;
    } else {
      history.push({ role, parts: [{ text }] });
    }
  }

  // History harus diakhiri dengan role 'model' atau kosong (bukan 'user')
  // karena pesan user terbaru akan dikirim via chat.sendMessage()
  // Hapus entry terakhir jika role-nya 'user' (itu akan jadi pesan saat ini)
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history.pop();
  }

  return history;
}

async function handleBotMention(code, userMsg, userName) {
  const geminiModel = getModelForRoom(code);
  if (!geminiModel) {
    sendBotMessage(code, '⚠️ Bot tidak aktif — masukkan Gemini API Key di halaman lobby sebelum bergabung room.');
    return;
  }

  // Strip @Qeets trigger from the message
  const query = userMsg.replace(/@Qeets\b/gi, '').trim();
  if (!query) {
    sendBotMessage(code, `Hai ${userName}! Tanya apa aja ke aku, ketik @Qeets <pertanyaanmu> 😊`);
    return;
  }

  io.to(code).emit('bot_typing', { typing: true });

  try {
    const history = buildChatHistory(code);

    const chat = geminiModel.startChat({
      history,
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const result = await chat.sendMessage(`[${userName}]: ${query}`);
    const text = result.response.text();
    sendBotMessage(code, text, userName);
  } catch (err) {
    console.error('[Gemini error]', err.message);
    console.error('[Gemini RAW error]', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    let errMsg = `Maaf ${userName}, aku sedang tidak bisa menjawab sekarang. Coba lagi nanti ya! 🙏`;
    if (err.message?.includes('404') || err.message?.includes('not found')) {
      errMsg = `⚠️ Model AI tidak ditemukan. Hubungi admin untuk memperbarui konfigurasi bot.`;
    } else if (err.message?.includes('429') || err.message?.includes('quota')) {
      errMsg = `⚠️ Batas penggunaan AI tercapai. Coba lagi dalam beberapa saat ya, ${userName}!`;
    } else if (err.message?.includes('API_KEY') || err.message?.includes('401')) {
      errMsg = `⚠️ Konfigurasi bot bermasalah. Hubungi admin ya!`;
    }

    sendBotMessage(code, errMsg, userName);
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

  // ── API Key (per-socket, from client) ──
  socket.on('set_api_key', ({ key }) => {
    if (key && typeof key === 'string' && key.length > 10) {
      socketApiKeys[socket.id] = key.trim();
      console.log(`[API key] Socket ${socket.id} set a Gemini key`);
    }
  });

  socket.on('set_api_key', ({ key }) => {
  if (key && typeof key === 'string' && key.length > 10) {
    socketApiKeys[socket.id] = key.trim();
    console.log(`[API key] Socket ${socket.id} set key: ${key.slice(0, 8)}...`);
  }
});

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

    // Check @Qeets Game trigger first
    if (text && /@Qeets\s+Game\b/i.test(text)) {
      handleGameStart(code, text, name);
    }
    // Check @Answer trigger (game answer)
    else if (text && /@Answer\b/i.test(text)) {
      handleGameAnswer(code, text, name);
    }
    // Check @Qeets trigger (normal bot)
    else if (text && /@Qeets\b/i.test(text)) {
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
  socket.on('disconnect', () => {
    handleLeave(socket);
    delete socketApiKeys[socket.id];
    console.log(`[disconnect] ${socket.id}`);
  });

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