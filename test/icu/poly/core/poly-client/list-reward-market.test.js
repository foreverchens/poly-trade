import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return reward markets list', async () => {
    const polyClient = createPolyClient();
    const result = await polyClient.listRewardMarket();
    
    assert(Array.isArray(result), 'Result should be an array');
    assert(result.length > 0, 'Result should not be empty');
    
    // Validate market structure
    const market = result[0];
    assert(market.market_id, 'Market should have market_id');
    assert(market.question, 'Market should have question');
    assert(Array.isArray(market.tokens), 'Market should have tokens array');
    assert(market.tokens.length >= 2, 'Market should have at least 2 tokens');
    assert(Array.isArray(market.rewards_config), 'Market should have rewards_config');
    assert(typeof market.market_competitiveness === 'number', 'Market should have market_competitiveness');
});

test('should return markets sorted by reward rate', async () => {
    const polyClient = createPolyClient();
    const result = await polyClient.listRewardMarket({ limit: 20 });
    
    if (result.length > 1) {
        // Check that markets are sorted by reward rate (descending)
        for (let i = 0; i < result.length - 1; i++) {
            const current = result[i].rewards_config[0]?.rate_per_day || 0;
            const next = result[i + 1].rewards_config[0]?.rate_per_day || 0;
            assert(
                current >= next,
                `Markets should be sorted by reward rate: ${current} >= ${next}`
            );
        }
    }
});

test('should filter markets with market_competitiveness > 0', async () => {
    const polyClient = createPolyClient();
    const result = await polyClient.listRewardMarket();
    
    result.forEach(market => {
        assert(
            market.market_competitiveness > 0,
            'All markets should have market_competitiveness > 0'
        );
    });
});

