// Servidor de retransmisión (relay) para Bee's League Multiverse.
// No conoce las reglas del juego: solo hace 2 cosas simples:
//  1) Une a 2 jugadores en una "sala" de PvP con un código y reenvía sus jugadas.
//  2) Un chat global (una sola sala llamada "lobby") para todos los que se conecten.

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end("Bee's League PvP relay + chat activo.");
});

const io = new Server(server, {
  cors: { origin: '*' }
});

// ---------- Salas de combate PvP ----------
// rooms: { CODE: { hostId, hostName, guestId, guestName } }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

// ---------- Chat global ----------
const CHAT_ROOM = 'lobby';
const chatHistory = []; // se guarda solo en memoria mientras el server esté vivo
const MAX_HISTORY = 50;

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.chatName = null;

  // --- PvP ---
  socket.on('create_room', (payload, cb) => {
    const code = generateCode();
    rooms[code] = { hostId: socket.id, hostName: (payload && payload.name) || 'Jugador', guestId: null, guestName: null };
    socket.join(code);
    socket.data.room = code;
    cb && cb({ ok: true, room: code });
  });

  socket.on('join_room', (payload, cb) => {
    const code = (payload && payload.room || '').toUpperCase();
    const room = rooms[code];
    if (!room) { cb && cb({ ok: false, error: 'not_found' }); return; }
    if (room.guestId) { cb && cb({ ok: false, error: 'room_full' }); return; }
    room.guestId = socket.id;
    room.guestName = (payload && payload.name) || 'Jugador';
    socket.join(code);
    socket.data.room = code;
    cb && cb({ ok: true, hostName: room.hostName });
    io.to(room.hostId).emit('peer_joined', { name: room.guestName });
  });

  socket.on('game_msg', (payload) => {
    const code = payload && payload.room;
    const room = rooms[code];
    if (!room) return;
    const otherId = room.hostId === socket.id ? room.guestId : room.hostId;
    if (otherId) io.to(otherId).emit('game_msg', payload.data);
  });

  // --- Chat global ---
  socket.on('chat_join', (payload) => {
    const name = ((payload && payload.name) || 'Jugador').toString().slice(0, 24);
    socket.data.chatName = name;
    socket.join(CHAT_ROOM);
    socket.emit('chat_history', chatHistory);
    const joinMsg = { system: true, text: `${name} se unió al chat.` };
    chatHistory.push(joinMsg);
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    socket.to(CHAT_ROOM).emit('chat_message', joinMsg);
  });

  socket.on('chat_message', (text) => {
    if (!socket.data.chatName) return;
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    const msg = { name: socket.data.chatName, text: clean, ts: Date.now() };
    chatHistory.push(msg);
    if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
    io.to(CHAT_ROOM).emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    // salida de sala PvP
    const code = socket.data.room;
    if (code) {
      const room = rooms[code];
      if (room) {
        const otherId = room.hostId === socket.id ? room.guestId : room.hostId;
        if (otherId) io.to(otherId).emit('peer_left');
        delete rooms[code];
      }
    }
    // salida del chat
    if (socket.data.chatName) {
      const leaveMsg = { system: true, text: `${socket.data.chatName} salió del chat.` };
      chatHistory.push(leaveMsg);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      socket.to(CHAT_ROOM).emit('chat_message', leaveMsg);
    }
  });
});

server.listen(PORT, () => console.log('PvP relay + chat escuchando en puerto ' + PORT));
