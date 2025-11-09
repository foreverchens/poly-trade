import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should get price history for token', async () => {
    const polyClient = createPolyClient();
    const tokenId = '78087950351996133232072167455070038424713819740092043518753101377185211074036';
    const result = await polyClient.getPricesHistory(tokenId);
    
    assert(result, 'Result should be returned');
    assert(Array.isArray(result.history), 'Result should have history array');
    
    if (result.history.length > 0) {
        const pricePoint = result.history[0];
        assert(typeof pricePoint.t === 'number', 'Price point should have timestamp');
        assert(typeof pricePoint.p === 'number', 'Price point should have price');
    }
});

