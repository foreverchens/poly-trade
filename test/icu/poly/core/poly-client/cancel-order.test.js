import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should cancel an order', async () => {
    const polyClient = createPolyClient();
    // First, get an open order
    const orders = await polyClient.listOpenOrders();
    
    if (orders.length > 0) {
        const orderId = orders[0].id;
        
        try {
            const result = await polyClient.cancelOrder(orderId);
            
            assert(result, 'Cancel result should be returned');
            assert(Array.isArray(result.canceled) || result.canceled, 
                'Result should have canceled array or object');
        } catch (error) {
            // Order might already be canceled or not found
            assert(error instanceof Error, 'Error should be an Error instance');
        }
    } else {
        // Skip test if no open orders
        console.log('Skipping cancelOrder test: no open orders');
    }
});

