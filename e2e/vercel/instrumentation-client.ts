import { initBotId } from 'botid/client/core';

// BotID attaches its challenge headers to these client requests; /api/botid verifies them.
initBotId({ protect: [{ path: '/api/botid', method: 'POST' }] });
