// ═══════════════════════════════════════════════
//  src/realtime/socket.js
//  WebSocket Server
// ═══════════════════════════════════════════════

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:3000',
        'https://qemma-platform.web.app',
      ],
      credentials: true,
    },
  });

  // ─── Auth Middleware ───
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.user = payload;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection ───
  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`🔌 Socket connected: ${user.email} (${user.sub})`);

    // ─── Rooms ───
    socket.join(`user:${user.sub}`);
    if (user.tenant_id) socket.join(`tenant:${user.tenant_id}`);
    if (user.organization_id) socket.join(`org:${user.organization_id}`);

    // ─── Test Event ───
    socket.on('ping', () => socket.emit('pong', { time: new Date() }));

    // ─── Disconnect ───
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${user.email}`);
    });
  });

  console.log('✅ Socket.io initialized');
  return io;
}

// ─── Emit Helpers ───
function emitToUser(userId, event, data) {
  if (io) io.to(`user:${userId}`).emit(event, data);
}

function emitToTenant(tenantId, event, data) {
  if (io) io.to(`tenant:${tenantId}`).emit(event, data);
}

function emitToOrg(orgId, event, data) {
  if (io) io.to(`org:${orgId}`).emit(event, data);
}

function broadcast(event, data) {
  if (io) io.emit(event, data);
}

module.exports = {
  initSocket,
  emitToUser,
  emitToTenant,
  emitToOrg,
  broadcast,
};