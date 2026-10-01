/**
 * Health module — `GET /webhook/health` liveness probe for external dashboards.
 *
 * Registered on host start (after DB, delivery and the gateway are ready), so
 * a 200 means startup got that far. See health-endpoint.ts for what it does
 * and does not prove.
 */
import { onHostStart } from '../../host-lifecycle.js';
import { registerHealthEndpoint } from './health-endpoint.js';

onHostStart(() => registerHealthEndpoint());
