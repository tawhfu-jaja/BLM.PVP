// Servidor de retransmisión (relay) para Bee's League Multiverse.
// No guarda nada en disco ni en una base de datos: todo vive en memoria
// mientras el servidor esté corriendo. Hace 5 cosas:
//  1) Une a 2 jugadores en una "sala" de PvP o Raid con un código y reenvía sus jugadas.
//  2) Un chat global (una sola sala "lobby") para todos los conectados.
//  3) Solicitudes de amistad entre jugadores conectados en ese momento.
//  4) Perfil rápido y mensajes directos entre amigos, mientras ambos estén conectados.
//  5) Intercambio de personajes 1 a 1 entre amigos conectados.

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end("Bee's League PvP relay + chat + amigos activo.");
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
const chatHistory = []; // solo en memoria mientras el server esté vivo
const MAX_HISTORY = 50;

// ---------- Jugadores conectados ahora mismo (para amigos/DMs) ----------
// onlinePlayers: { playerId: { socketId, name } }
const onlinePlayers = {};

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.chatName = null;
  socket.data.playerId = null;

  // --- Identidad (necesaria para amigos, perfil y DMs) ---
  socket.on('register', (payload) => {
    const playerId = ((payload && payload.playerId) || '').toString().slice(0, 40);
    const name = ((payload && payload.name) || 'Jugador').toString().slice(0, 24);
    if (!playerId) return;
    socket.data.playerId = playerId;
    onlinePlayers[playerId] = { socketId: socket.id, name };
  });

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

  // --- Amigos: solicitudes ---
  socket.on('friend_request', (payload, cb) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromName = ((payload && payload.fromName) || 'Jugador').toString().slice(0, 24);
    const fromId = socket.data.playerId;
    if (!fromId) { cb && cb({ ok: false, error: 'not_registered' }); return; }
    const target = onlinePlayers[toId];
    if (!target) { cb && cb({ ok: false, error: 'offline' }); return; }
    io.to(target.socketId).emit('friend_request_incoming', { fromId, fromName });
    cb && cb({ ok: true });
  });

  socket.on('friend_response', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromName = ((payload && payload.fromName) || 'Jugador').toString().slice(0, 24);
    const accepted = !!(payload && payload.accepted);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('friend_response_incoming', { fromId, fromName, accepted });
  });

  // --- Perfil rápido entre amigos ---
  socket.on('profile_request', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('profile_request_incoming', { fromId });
  });

  socket.on('profile_response', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const profile = (payload && payload.profile) || {};
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('profile_response_incoming', { profile });
  });

  // --- Intercambios ---
  socket.on('trade_request', (payload, cb) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromName = ((payload && payload.fromName) || 'Jugador').toString().slice(0, 24);
    const fromId = socket.data.playerId;
    if (!fromId) { cb && cb({ ok: false, error: 'not_registered' }); return; }
    const target = onlinePlayers[toId];
    if (!target) { cb && cb({ ok: false, error: 'offline' }); return; }
    io.to(target.socketId).emit('trade_request_incoming', { fromId, fromName });
    cb && cb({ ok: true });
  });

  socket.on('trade_response', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromName = ((payload && payload.fromName) || 'Jugador').toString().slice(0, 24);
    const accepted = !!(payload && payload.accepted);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('trade_response_incoming', { fromId, fromName, accepted });
  });

  socket.on('trade_offer', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const charId = ((payload && payload.charId) || '').toString().slice(0, 60);
    const charName = ((payload && payload.charName) || '').toString().slice(0, 60);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('trade_offer_incoming', { fromId, charId, charName });
  });

  socket.on('trade_confirm', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('trade_confirm_incoming', { fromId });
  });

  socket.on('trade_cancel', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromId = socket.data.playerId;
    if (!fromId) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('trade_cancel_incoming', { fromId });
  });

  // --- Mensajes directos ---
  socket.on('dm_message', (payload) => {
    const toId = ((payload && payload.toId) || '').toString().slice(0, 40);
    const fromName = ((payload && payload.fromName) || 'Jugador').toString().slice(0, 24);
    const text = String((payload && payload.text) || '').slice(0, 400).trim();
    const fromId = socket.data.playerId;
    if (!fromId || !text) return;
    const target = onlinePlayers[toId];
    if (target) io.to(target.socketId).emit('dm_message_incoming', { fromId, fromName, text, ts: Date.now() });
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
    // salir de la lista de jugadores conectados
    if (socket.data.playerId && onlinePlayers[socket.data.playerId] && onlinePlayers[socket.data.playerId].socketId === socket.id) {
      delete onlinePlayers[socket.data.playerId];
    }
  });
});

server.listen(PORT, () => console.log('PvP relay + chat + amigos escuchando en puerto ' + PORT));
