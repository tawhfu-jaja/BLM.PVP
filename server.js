// Servidor de retransmisión (relay) PvP + ranking diario de victorias
// para Bee's League Multiverse.
//
// - El PvP (socket.io) sigue siendo un simple relay: no conoce las reglas del juego.
// - El ranking usa Supabase (Postgres gratis para siempre) para que los
//   puntajes no se pierdan cuando Render reinicia el servidor por inactividad.

const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // Sumar una victoria
  if (req.method === 'POST' && url.pathname === '/win') {
    if (!supabase) { sendJson(res, 500, { ok: false, error: 'ranking_not_configured' }); return; }
    const body = await readBody(req);
    const playerId = (body.playerId || '').toString().slice(0, 40);
    const name = (body.name || 'Jugador').toString().slice(0, 30);
    if (!playerId) { sendJson(res, 400, { ok: false, error: 'missing_playerId' }); return; }
    const day = todayStr();
    try {
      const { data: existing } = await supabase
        .from('pvp_wins')
        .select('id, wins')
        .eq('player_id', playerId)
        .eq('day', day)
        .maybeSingle();

      if (existing) {
        await supabase.from('pvp_wins').update({ wins: existing.wins + 1, name }).eq('id', existing.id);
      } else {
        await supabase.from('pvp_wins').insert({ player_id: playerId, name, day, wins: 1 });
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'db_error' });
    }
    return;
  }

  // Ver el ranking de hoy
  if (req.method === 'GET' && url.pathname === '/ranking') {
    if (!supabase) { sendJson(res, 200, { ok: true, date: todayStr(), rows: [] }); return; }
    const day = url.searchParams.get('date') || todayStr();
    try {
      const { data, error } = await supabase
        .from('pvp_wins')
        .select('name, wins')
        .eq('day', day)
        .order('wins', { ascending: false })
        .limit(20);
      if (error) throw error;
      sendJson(res, 200, { ok: true, date: day, rows: data || [] });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'db_error' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { ok: true, message: "Bee's League PvP relay + ranking activo." });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
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

server.listen(PORT, () => console.log('PvP relay + ranking escuchando en puerto ' + PORT));
