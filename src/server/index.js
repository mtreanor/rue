import express from 'express';
import { router } from './routes.js';
import { configPath } from './config.js';

// The RUE server: one HTTP process that every client of a running RUE talks
// to — programs driving experiments, and the action-rule-set-tool. Its own API
// is under /api (see docs/server-api.md). A host extends it by passing extra
// routers, which are mounted under /api alongside the core routes; the
// authoring tool does exactly this, so there is only ever one server.

export function createApp({ routers = [] } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', router);
  for (const extra of routers) app.use('/api', extra);
  return app;
}

export function startServer({ port = process.env.PORT || 5174, routers = [], name = 'RUE server' } = {}) {
  const server = createApp({ routers }).listen(port, () => {
    console.log(`${name} listening on http://localhost:${port}`);
    console.log(`  project config: ${configPath}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[${name}] Port ${port} is already in use — another process (likely a stale ` +
        `server) is holding it.\n` +
        `Free it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN   then  kill <pid>\n` +
        `or run on another port:  PORT=5184 npm run server  (the tool's Vite proxy expects 5174).\n`,
      );
      process.exit(1);
    }
    throw err;
  });
  return server;
}
