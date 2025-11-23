import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import prisma from '../../../../src/icu/poly/db/client.js';
import { saveOrder, listOrders, deleteOrder } from '../../../../src/icu/poly/db/repository.js';

describe('Database Connection and Operations', () => {
    const testOrderId = `test-${Date.now()}`;
    const testOrder = {
        eventSlug: 'test-event',
        marketSlug: 'test-market',
        side: 'BUY',
        outcome: 'YES',
        orderId: testOrderId,
        price: 0.5,
        size: 100,
        tokenId: 'test-token-id',
        zScore: 1.5,
        secondsToEnd: 300,
        priceChange: 0.01,
        isLiquiditySignal: false
    };

    // Clean up before running tests just in case
    before(async () => {
        try {
            await prisma.order.delete({ where: { orderId: testOrderId } });
        } catch (e) {
            // Ignore if not found
        }
    });

    after(async () => {
        // Cleanup
        try {
            await deleteOrder(testOrder.id);
        } catch (e) {
           // Try to delete by orderId directly if the above fails or if id wasn't captured
           try {
               await prisma.order.delete({ where: { orderId: testOrderId } });
           } catch (inner) {
               // ignore
           }
        }
        await prisma.$disconnect();
    });

    it('should successfully save an order', async () => {
        const savedOrder = await saveOrder(testOrder);
        assert.ok(savedOrder.id, 'Order should have an ID');
        assert.strictEqual(savedOrder.orderId, testOrderId);
        assert.strictEqual(savedOrder.price, 0.5);

        // Update the testOrder object with the generated ID for subsequent tests/cleanup
        testOrder.id = savedOrder.id;
    });

    it('should successfully read the saved order', async () => {
        const orders = await listOrders(100);
        const found = orders.find(o => o.orderId === testOrderId);

        assert.ok(found, 'Should find the saved order');
        assert.strictEqual(found.eventSlug, 'test-event');
        assert.strictEqual(found.side, 'BUY');
    });

    it('should verify write permissions by updating the order', async () => {
        // Direct prisma update to verify write access
        const updated = await prisma.order.update({
            where: { id: testOrder.id },
            data: { price: 0.55 }
        });
        assert.strictEqual(updated.price, 0.55);
    });
});

