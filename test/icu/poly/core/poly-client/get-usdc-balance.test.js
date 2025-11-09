import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return USDC balance', async () => {
    const polyClient = createPolyClient();
    const balance = await polyClient.getUsdcBalance();
    
    assert(balance !== undefined, 'Balance should be returned');
    assert(typeof balance === 'string', 'Balance should be a string');
    assert(parseFloat(balance) >= 0, 'Balance should be non-negative');
});

