// Venue account linking (30 Oct 2026). The handler and its rules: netlify/lib/linking-handlers.mjs and linking.mjs.
import { polymarketUnlink, realDeps } from '../lib/linking-handlers.mjs';

export default polymarketUnlink(realDeps());
