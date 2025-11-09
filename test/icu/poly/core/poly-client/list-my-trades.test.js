import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return my trades list', async () => {
    const polyClient = createPolyClient();
    const trades = await polyClient.listMyTrades();
    
    assert(Array.isArray(trades), 'Trades should be an array');
});

