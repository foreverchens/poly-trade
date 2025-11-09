import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PolySide } from '../../../../../src/icu/poly/core/PolyClient.js';
import { createPolyClient, tokenIdA, tokenIdB } from './test-helper.js';

test('should get buy price for token', async () => {
    const polyClient = createPolyClient();
    const price = await polyClient.getPrice(PolySide.BUY, tokenIdA);
    
    assert(typeof price === 'string' || typeof price === 'number', 'Price should be a number or string');
    const priceNum = typeof price === 'string' ? parseFloat(price) : price;
    assert(priceNum >= 0 && priceNum <= 1, 'Price should be between 0 and 1');
});

test('should get sell price for token', async () => {
    const polyClient = createPolyClient();
    const price = await polyClient.getPrice(PolySide.SELL, tokenIdA);
    
    assert(typeof price === 'string' || typeof price === 'number', 'Price should be a number or string');
    const priceNum = typeof price === 'string' ? parseFloat(price) : price;
    assert(priceNum >= 0 && priceNum <= 1, 'Price should be between 0 and 1');
});

test('should get prices for multiple tokens', async () => {
    const polyClient = createPolyClient();
    const [priceA, priceB] = await Promise.all([
        polyClient.getPrice(PolySide.BUY, tokenIdA),
        polyClient.getPrice(PolySide.BUY, tokenIdB)
    ]);
    
    assert(priceA !== undefined, 'Token A price should be defined');
    assert(priceB !== undefined, 'Token B price should be defined');
});

