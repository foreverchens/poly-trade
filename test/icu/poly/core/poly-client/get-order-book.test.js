import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient, tokenIdA } from './test-helper.js';

test('should get order book for token', async () => {
    const polyClient = createPolyClient();
    const orderBook = await polyClient.getOrderBook(tokenIdA);
    
    assert(orderBook, 'Order book should be returned');
    assert(Array.isArray(orderBook.bids) || orderBook.bids, 'Order book should have bids');
    assert(Array.isArray(orderBook.asks) || orderBook.asks, 'Order book should have asks');
});

