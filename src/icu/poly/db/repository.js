import prisma from './client.js';

/**
 * Save a new order to the database
 * @param {Object} orderData
 * @returns {Promise<Object>}
 */
export async function saveOrder(orderData) {
    try {
        const size = parseFloat(orderData.size);
        // 建仓订单在第一次存储时，matched默认与size字段一致
        // 如果是止盈订单（有parentOrderId），matched默认为0，后续根据实际撮合情况更新
        const matched = orderData.parentOrderId ? (orderData.matched !== undefined ? parseFloat(orderData.matched) : 0) : size;

        return await prisma.order.create({
            data: {
                eventSlug: orderData.eventSlug,
                marketSlug: orderData.marketSlug,

                side: orderData.side,
                outcome: orderData.outcome,
                orderId: orderData.orderId,
                price: parseFloat(orderData.price),
                size: size,
                matched: matched,
                profit: orderData.profit !== undefined ? parseFloat(orderData.profit) : 0,

                parentOrderId: orderData.parentOrderId || null,

                tokenId: orderData.tokenId || null,
                zScore: orderData.zScore ? parseFloat(orderData.zScore) : null,
                secondsToEnd: orderData.secondsToEnd ? parseInt(orderData.secondsToEnd) : null,
                priceChange: orderData.priceChange ? parseFloat(orderData.priceChange) : null,
                isLiquiditySignal: orderData.isLiquiditySignal || false,
            },
        });
    } catch (error) {
        console.error('Failed to save order to DB:', error);
        throw error;
    }
}

/**
 * List all orders sorted by creation date descending
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function listOrders(limit = 100) {
    return await prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
}

/**
 * Delete an order by its ID (UUID)
 * @param {string} id
 * @returns {Promise<Object>}
 */
export async function deleteOrder(id) {
    try {
        return await prisma.order.delete({
            where: { id },
        });
    } catch (error) {
        console.error('Failed to delete order from DB:', error);
        throw error;
    }
}

/**
 * Update an order
 * @param {string} id
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function updateOrder(id, data) {
    try {
        const updateData = {};
        // Only allow updating specific fields to avoid accidental overwrites
        if (data.price !== undefined) updateData.price = parseFloat(data.price);
        if (data.size !== undefined) updateData.size = parseFloat(data.size);
        if (data.side !== undefined) updateData.side = data.side;
        if (data.outcome !== undefined) updateData.outcome = data.outcome;
        if (data.matched !== undefined) updateData.matched = parseFloat(data.matched);
        if (data.profit !== undefined) updateData.profit = parseFloat(data.profit);

        return await prisma.order.update({
            where: { id },
            data: updateData,
        });
    } catch (error) {
        console.error('Failed to update order in DB:', error);
        throw error;
    }
}

/**
 * Find an order by orderId
 * @param {string} orderId
 * @returns {Promise<Object|null>}
 */
export async function findOrderByOrderId(orderId) {
    try {
        return await prisma.order.findUnique({
            where: { orderId },
        });
    } catch (error) {
        console.error('Failed to find order by orderId:', error);
        throw error;
    }
}

/**
 * Update an order's matched and profit by orderId
 * @param {string} orderId
 * @param {number} matched
 * @param {number} profit
 * @returns {Promise<Object>}
 */
export async function updateOrderMatchedAndProfit(orderId, matched, profit) {
    try {
        return await prisma.order.update({
            where: { orderId },
            data: {
                matched: parseFloat(matched),
                profit: parseFloat(profit),
            },
        });
    } catch (error) {
        console.error('Failed to update order matched and profit:', error);
        throw error;
    }
}
