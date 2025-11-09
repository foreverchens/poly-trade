import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return crypto events list', async () => {
    const polyClient = createPolyClient();
    const result = await polyClient.listCryptoEvents();
    
    assert(Array.isArray(result), 'Result should be an array');
    
    if (result.length > 0) {
        const event = result[0];
        assert(event.id, 'Event should have id');
        assert(event.ticker, 'Event should have ticker');
        assert(event.title, 'Event should have title');
        assert(Array.isArray(event.markets), 'Event should have markets array');
    }
});

