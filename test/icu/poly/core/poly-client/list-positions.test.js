import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPolyClient } from './test-helper.js';

test('should return positions list', async () => {
    const polyClient = createPolyClient();
    const positions = await polyClient.listPositions();
    
    assert(Array.isArray(positions), 'Positions should be an array');
});

