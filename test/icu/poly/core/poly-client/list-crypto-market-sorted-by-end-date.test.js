import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createPolyClient} from './test-helper.js';

test('should return crypto markets sorted by end date', async () => {
    const polyClient = createPolyClient();
    const result = await polyClient.listCryptoMarketSortedByEndDate();

    assert(Array.isArray(result), 'Result should be an array');

    if (result.length > 0) {
        const market = result[0];
        assert(market.id, 'Market should have id');
        assert(market.question, 'Market should have question');
        assert(market.endDate, 'Market should have endDate');
        assert(market.lastTradePrice >= 0.01 && market.lastTradePrice <= 0.99,
            'lastTradePrice should be between 0.01 and 0.99');
        assert(market.bestAsk >= 0.01 && market.bestAsk <= 0.99,
            'bestAsk should be between 0.01 and 0.99');
    }
});

