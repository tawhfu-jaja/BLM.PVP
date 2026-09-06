// Servidor de retransmisión (relay) para el PvP de Bee's League Multiverse.
// No conoce nada de las reglas del juego: solo une a 2 jugadores en una
// "sala" con un código, y reenvía los mensajes que se mandan entre ellos.

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bee\'s League PvP relay activo.');
});

const io = new Server(server, {
  cors: { origin: '*' }
});

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

io.on('connection', (socket) => {
  socket.data.room = null;

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
    // reenvía al otro socket de la sala
    const otherId = room.hostId === socket.id ? room.guestId : room.hostId;
    if (otherId) io.to(otherId).emit('game_msg', payload.data);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    const otherId = room.hostId === socket.id ? room.guestId : room.hostId;
    if (otherId) io.to(otherId).emit('peer_left');
    delete rooms[code];
  });
});

server.listen(PORT, () => console.log('PvP relay escuchando en puerto ' + PORT));
