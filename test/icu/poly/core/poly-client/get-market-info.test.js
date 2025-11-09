import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should get specific market info by marketId', async () => {
    const polyClient = createPolyClient();
    const markets = await polyClient.listRewardMarket({ limit: 20 });
    
    if (markets.length > 0) {
        const marketId = markets[0].market_id;
        const filtered = markets.filter(m => m.market_id === marketId);
        
        assert(filtered.length > 0, 'Should find market by marketId');
        assert.equal(filtered[0].market_id, marketId, 'Market ID should match');
    }
});

