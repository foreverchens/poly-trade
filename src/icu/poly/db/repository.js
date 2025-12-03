import prisma from './client.js';

/**
 * Save a new entry order to the database (建仓订单)
 * @param {Object} orderData
 * @returns {Promise<Object>}
 */
export async function saveOrder(orderData) {
    try {
        const size = parseFloat(orderData.size);
        // 建仓订单在第一次存储时，matched默认与size字段一致
        const matched = size;

        const order = await prisma.order.create({
            data: {
                eventSlug: orderData.eventSlug,
                marketSlug: orderData.marketSlug,

                side: orderData.side,
                outcome: orderData.outcome,
                status: 'pending', // 建仓时状态为 pending

                entry_order_id: orderData.entryOrderId,
                entry_price: parseFloat(orderData.entryPrice),
                size: size,
                matched: matched,

                profit_order_id: null,
                profit_price: null,
                profit: 0,

                tokenId: orderData.tokenId || null,
                zScore: orderData.zScore ? parseFloat(orderData.zScore) : null,
                secondsToEnd: orderData.secondsToEnd ? parseInt(orderData.secondsToEnd) : null,
                priceChange: orderData.priceChange ? parseFloat(orderData.priceChange) : null,
                isLiquiditySignal: orderData.isLiquiditySignal || false,
            },
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to save order to DB:', error);
        throw error;
    }
}

/**
 * Convert order from database format to API format (snake_case to camelCase)
 * @param {Object} order
 * @returns {Object}
 */
function formatOrderForAPI(order) {
    if (!order) return null;
    return {
        ...order,
        entryOrderId: order.entry_order_id,
        entryPrice: order.entry_price,
        profitOrderId: order.profit_order_id,
        profitPrice: order.profit_price,
    };
}

/**
 * List all orders sorted by creation date descending
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function listOrders(limit = 100) {
    const orders = await prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
    return orders.map(formatOrderForAPI);
}

/**
 * Delete an order by its ID (Int)
 * @param {number} id
 * @returns {Promise<Object>}
 */
export async function deleteOrder(id) {
    try {
        const order = await prisma.order.delete({
            where: { id: parseInt(id) },
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to delete order from DB:', error);
        throw error;
    }
}

/**
 * Update an order
 * @param {number} id
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function updateOrder(id, data) {
    try {
        const updateData = {};
        // Only allow updating specific fields to avoid accidental overwrites
        if (data.entry_price !== undefined) {
            updateData.entry_price = parseFloat(data.entry_price);
        }
        if (data.size !== undefined) updateData.size = parseFloat(data.size);
        if (data.side !== undefined) updateData.side = data.side;
        if (data.outcome !== undefined) updateData.outcome = data.outcome;
        if (data.matched !== undefined) updateData.matched = parseFloat(data.matched);
        if (data.profit !== undefined) updateData.profit = parseFloat(data.profit);
        if (data.status !== undefined) updateData.status = data.status;

        const order = await prisma.order.update({
            where: { id: parseInt(id) },
            data: updateData,
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to update order in DB:', error);
        throw error;
    }
}

/**
 * Find an order by entry_order_id
 * @param {string} entryOrderId
 * @returns {Promise<Object|null>}
 */
export async function findOrderByEntryOrderId(entryOrderId) {
    try {
        const order = await prisma.order.findUnique({
            where: { entry_order_id: entryOrderId },
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to find order by entry_order_id:', error);
        throw error;
    }
}

/**
 * Update an order's matched and profit by entry_order_id
 * @param {string} entryOrderId
 * @param {number} matched
 * @param {number} profit
 * @returns {Promise<Object>}
 */
export async function updateOrderMatchedAndProfit(entryOrderId, matched, profit) {
    try {
        const order = await prisma.order.update({
            where: { entry_order_id: entryOrderId },
            data: {
                matched: parseFloat(matched),
                profit: parseFloat(profit),
            },
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to update order matched and profit:', error);
        throw error;
    }
}

/**
 * Update take profit information (更新止盈信息)
 * @param {string} entryOrderId
 * @param {string} profitOrderId
 * @param {number} profitPrice
 * @param {number} profit
 * @returns {Promise<Object>}
 */
export async function updateTakeProfit(entryOrderId, profitOrderId, profitPrice, profit) {
    try {
        const order = await prisma.order.update({
            where: { entry_order_id: entryOrderId },
            data: {
                profit_order_id: profitOrderId,
                profit_price: parseFloat(profitPrice),
                profit: parseFloat(profit),
                status: 'take_profit',
            },
        });
        return formatOrderForAPI(order);
    } catch (error) {
        console.error('Failed to update take profit:', error);
        throw error;
    }
}
