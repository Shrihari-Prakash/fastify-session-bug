const { default: fastify } = require('fastify');
const fastifySession = require('@fastify/session');
const fastifyCookie = require('@fastify/cookie');
const fastifyStatic = require('@fastify/static');
const socketIO = require('fastify-socket.io');
const connectRedis = require('connect-redis');
const Redis = require('ioredis');
const path = require('path');

const RedisStore = connectRedis(fastifySession);
const redisClient = new Redis({
  port: 6379,
  host: 'localhost',
  password: '',
  db: 0,
});

const app = fastify({
  disableRequestLogging: true,
});

app.register(fastifyStatic, {
  root: path.join(__dirname),
});

const sessionCookieOptions = {
  path: '/',
  httpOnly: true,
  sameSite: false,
  maxAge: 3600 * 1000,
  secure: false,
};

app.register(fastifyCookie);

const sessionOpts = {
  secret: 'b7788e67-3ccb-4c2f-ui4d-dbn67k27316f',
  cookieName: 'sid',
  cookie: sessionCookieOptions,
  saveUninitialized: false,
  store: new RedisStore({
    client: redisClient,
  }),
};

app.register(fastifySession, sessionOpts);

app.register(socketIO, {
  path: `/realtime`,
  cors: {
    origin: '*',
    credentials: true,
  },
});

function rejectSocket(socket, reply, reject) {
  console.log(`Unauthorized request in socket %s.`, socket.id);
  reply.sendError(StatusHTTP.Unauthorized, StatusCode.Unauthorized);
  socket.disconnect();
  return reject();
}

function scheduleSessionTouch(socket, session) {
  if (socket.touchInterval) {
    clearInterval(socket.touchInterval);
  }
  const touchSession = () => {
    session.touch(session);
    session.save(session);
  };
  const touchInterval = setInterval(touchSession, 5 * 1000);
  touchSession();
  socket.touchInterval = touchInterval;
  console.log('Session touch scheduled for socket: %s', socket.id);
}

const realtimeConnectMiddleware = function (socket) {
  return new Promise((resolve, reject) => {
    console.log('Socket connected: %s', socket.id);
    const cookies = socket.request.headers?.cookie;
    if (!cookies) {
      return rejectSocket(socket, reject);
    }
    const sessionId = app.parseCookie(cookies)?.sid;
    const request = socket.request;
    if (!sessionId) {
      return rejectSocket(socket, reject);
    }
    app.decryptSession(sessionId, request, () => {
      const session = request.session;
      if (!session.get('details')) {
        return rejectSocket(socket, reply, reject);
      }
      scheduleSessionTouch(socket, session);
      return resolve();
    });
  });
};

app.ready((err) => {
  if (err) {
    throw err;
  }
  app.io.of('/my-app').on('connection', async (socket) => {
    try {
      await realtimeConnectMiddleware(socket);
      socket.on('disconnect', () => {
        clearInterval(socket.touchInterval);
        console.log('Touch interval cleared for socket: %s', socket.id);
      });
    } catch {
      log.error('Cannot initialize realtime for socket: %s', socket.id);
    }
  });
});

app.get('/', function (req, reply) {
  reply.download('index.html', { cacheControl: false }); // serving a file disabling cache-control headers
});

app.post('/login', function (req, reply) {
  req.session.set('details', { name: 'shr' });
  reply.send({ ok: 1 });
});

if (require.main === module) {
  const appListenCallback = (err) => {
    if (err) {
      return console.error(err);
    }

    console.log('Service listening on port ' + 5000);
  };
  app.listen({ port: 5000, host: '0.0.0.0' }, appListenCallback);
}
