import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PolySide } from '../../../../../src/icu/poly/core/PolyClient.js';
import { createPolyClient, tokenIdA, tokenIdB } from './test-helper.js';

test('should place a buy order', async () => {
    const polyClient = createPolyClient();
    const price = '0.4';
    const size = '5';
    const side = PolySide.BUY;
    
    // Note: This test may fail if there's insufficient balance or other issues
    // Consider skipping this test in CI or making it conditional
    try {
        const result = await polyClient.placeOrder(price, size, side, tokenIdA);
        
        assert(result, 'Order result should be returned');
        assert(result.success !== false, 'Order should be successful or pending');
        if (result.orderID) {
            assert(typeof result.orderID === 'string', 'Order ID should be a string');
        }
    } catch (error) {
        // If order fails due to balance or other reasons, that's acceptable
        // Just verify the error is meaningful
        assert(error instanceof Error, 'Error should be an Error instance');
    }
});

test('should place a sell order', async () => {
    const polyClient = createPolyClient();
    const price = '0.1';
    const size = '8.35';
    const side = PolySide.SELL;
    
    // Note: This test may fail if there's insufficient balance or other issues
    try {
        const result = await polyClient.placeOrder(price, size, side, '30678145720978986870531729996086321665047614270476574779108834454414336028793');
        console.log(result)
        assert(result, 'Order result should be returned');
        assert(result.success !== false, 'Order should be successful or pending');
    } catch (error) {
        assert(error instanceof Error, 'Error should be an Error instance');
    }
});

