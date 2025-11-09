import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return open orders list', async () => {
    const polyClient = createPolyClient();
    const orders = await polyClient.listOpenOrders();
    
    assert(Array.isArray(orders), 'Orders should be an array');
    
    if (orders.length > 0) {
        const order = orders[0];
        assert(order.id, 'Order should have id');
        assert(order.market, 'Order should have market');
        assert(order.asset_id, 'Order should have asset_id');
        assert(order.side, 'Order should have side');
        assert(order.price, 'Order should have price');
        assert(order.original_size, 'Order should have original_size');
        console.log(orders)
    }
});

test('should filter orders by market', async () => {
    const polyClient = createPolyClient();
    const allOrders = await polyClient.listOpenOrders();
    
    if (allOrders.length > 0) {
        const market = allOrders[0].market;
        const filteredOrders = await polyClient.listOpenOrders({ market });
        
        assert(Array.isArray(filteredOrders), 'Filtered orders should be an array');
        filteredOrders.forEach(order => {
            assert.equal(order.market, market, 'All orders should match the market filter');
        });
    }
});

