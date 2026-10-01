import './env.js';
import { startServer } from '../../../src/server/index.js';
import { router } from './routes.js';
import { installTool } from './install.js';

// The RUE server with the tool's authoring routes mounted on it — one process,
// one port. The core Play API is served exactly as `npm run server` from the
// RUE root would serve it.
installTool();
startServer({ routers: [router], name: 'RUE server + action-rule-set-tool' });
