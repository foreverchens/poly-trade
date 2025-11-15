import { readFile, writeFile } from "fs/promises";
import { setTimeout as wait } from "timers/promises";
import { PolyClient, PolySide } from "./core/PolyClient.js";

const DATA_PATH = new URL("./data/single-market-grid.data.json", import.meta.url);
const GRID = [1, 0.99, 0.97, 0.95, 0.93, 0.9, 0.86, 0.81, 0.75, 0.68, 0.55, 0];
const LOOP_MS = 1_000 * 10;
const INIT_ORDER_POLL_MS = 2_000; // 初始订单轮询间隔 2 秒
const INIT_ORDER_TIMEOUT_MS = 60_000; // 初始订单超时时间 60 秒

const polyClient = new PolyClient();

// 读取 tasks 节点，将静态配置与 runtime 状态放在同一 JSON 中
/**
 *
 * @returns {Promise<{blob: ({tasks}|any), task: {
 *       "label": "btc-102k-106k-grid",
 *       "slug": "bitcoin-above-on-november-16",
 *       "marketId": "0x2f571d82c1c233e073348e4bcf970d6c6cfd5550edf079cd6bf805db1c46ed2f",
 *       "tradeUsd": 10,
 *       "initPosition": 10,
 *       "status": 0
 * }}>}
 */
async function loadTask() {
    console.log("[加载] 正在读取任务配置...");
    const blob = JSON.parse(await readFile(DATA_PATH, "utf8"));
    if (!blob?.tasks) throw new Error("tasks missing in short-strangle-grid.data.json");
    const task = blob.tasks[0];
    task.runtime = task.runtime ?? {};
    return { blob, task };
}

async function saveTask(ctx) {
    await writeFile(DATA_PATH, `${JSON.stringify(ctx.blob, null, 4)}\n`, "utf8");
    // 静默保存，不输出日志避免刷屏
}

/**
 * 
 *         {
            "label": "btc-102k-106k-grid",
            "slug": "bitcoin-above-on-november-16",
            "marketId": "0x2f571d82c1c233e073348e4bcf970d6c6cfd5550edf079cd6bf805db1c46ed2f",
            "tradeUsd": 10,
            "initPosition": 10,
            "status": 0
        }
 * @param {*} task 
 * @returns 
 */
async function tryStart(task) {
    console.log("[初始化] 开始初始化任务...");
    const { slug, tradeUsd, initPosition } = task;

    console.log(`[初始化] 正在获取市场信息: ${slug}`);
    const market = await polyClient.getMarketBySlug(slug);
    if (!market) {
        console.log(`[初始化] 市场不存在: ${slug}`);
        return false;
    }

    if (!market.clobTokenIds) {
        console.log(`[初始化] 市场缺少 clobTokenIds`);
        return false;
    }

    // 获取 YES tokenId (第一个 token)
    const tokenIds = JSON.parse(market.clobTokenIds);
    const tokenId = tokenIds[0];
    console.log(`[初始化] 市场: ${market.slug}, TokenId: ${tokenId}`);

    // 获取当前最佳价格
    const [bestBidPrice, bestAskPrice] = await polyClient.getBestPrice(tokenId);
    console.log(`[初始化] 当前价格: 买=${bestBidPrice.toFixed(3)}, 卖=${bestAskPrice.toFixed(3)}`);

    if (bestAskPrice === 0) {
        console.log(`[初始化] 无法获取有效价格`);
        return false;
    }

    // 基于 initPosition 和 bestAskPrice 进行初始买入
    let initSize = 0;
    const initOrder = null;
    if (initPosition > 0) {
        // 初始仓位倍数大于0、进行初始买入
        initSize = Math.abs(Math.floor(initPosition * tradeUsd / bestAskPrice));
        console.log(`[初始化] 初始买入: 价格=${bestAskPrice}, 数量=${initSize}, 金额=${(initSize * bestAskPrice).toFixed(2)}U`);

        initOrder = await polyClient.placeOrder(bestAskPrice, initSize, PolySide.BUY, tokenId);
        console.log(`[初始化] 初始买入订单已提交: ${initOrder.orderID}`);

        // 轮询等待初始订单成交
        console.log(`[初始化] 等待初始订单成交...`);
        const startTime = Date.now();
        let orderFilled = false;
        while (Date.now() - startTime < INIT_ORDER_TIMEOUT_MS) {
            const order = await polyClient.getOrder(initOrder.orderID);
            if (!order || order.status === "MATCHED") {
                // 订单已成交（getOrder 返回 null 表示已成交）
                orderFilled = true;
                console.log(`[初始化] 初始订单已成交: ${initOrder.orderID}`);
                break;
            }
            console.log(`[初始化] 订单尚未成交，继续等待... (已等待 ${Math.floor((Date.now() - startTime) / 1000)}s)`);
            await wait(INIT_ORDER_POLL_MS);
        }

        if (!orderFilled) {
            console.log(`[初始化] 初始订单超时未成交，无法继续初始化`);
            return false;
        }
    }


    // 计算网格价格：上挂卖单（更高价格），下挂买单（更低价格）
    const sellPrice = getNextPrice(bestAskPrice, PolySide.SELL);
    const buyPrice = getNextPrice(bestAskPrice, PolySide.BUY);

    if (sellPrice <= 0 || buyPrice <= 0) {
        console.log(`[初始化] 无法计算网格价格 (sellPrice: ${sellPrice}, buyPrice: ${buyPrice})`);
        return false;
    }

    // 计算网格订单数量
    const gridBuySize = Math.abs(Math.floor(tradeUsd / buyPrice));
    const gridSellSize = Math.abs(Math.floor(tradeUsd / sellPrice));
    console.log(`[初始化] 网格买单: 价格=${buyPrice}, 数量=${gridBuySize}, 金额=${(gridBuySize * buyPrice).toFixed(2)}U`);
    console.log(`[初始化] 网格卖单: 价格=${sellPrice}, 数量=${gridSellSize}, 金额=${(gridSellSize * sellPrice).toFixed(2)}U`);

    // 提交网格挂单
    const buyOrder = await polyClient.placeOrder(buyPrice, gridBuySize, PolySide.BUY, tokenId);
    const sellOrder = await polyClient.placeOrder(sellPrice, gridSellSize, PolySide.SELL, tokenId);

    task.runtime = {
        tokenId: tokenId,
        buyPrice: buyPrice,
        sellPrice: sellPrice,
        position: initSize,
        initOrder: initOrder?.orderID,
        openOrders: [buyOrder.orderID, sellOrder.orderID],
        history: []
    };
    console.log(`[初始化] 初始化完成，状态已切换为运行中`);
    task.status = 1;
    task.remark = "初始化成功";
    return true;
}
/**
 * 根据当前价格和方向、获取下一交易价格
 * @param {number} curPrice 当前价格
 * @param {PolySide} side 交易方向
 * @returns {number|undefined} 下一交易价格
 */
function getNextPrice(curPrice, side) {
    curPrice = Number(curPrice);
    for (let i = 1; i < GRID.length - 1; i++) {
        if (curPrice <= GRID[i] && curPrice >= GRID[i + 1]) {
            if (side === PolySide.BUY) {
                return (curPrice - (GRID[i] - GRID[i + 1])).toFixed(3);
            } else {
                return (curPrice + (GRID[i - 1] - GRID[i])).toFixed(3);
            }
        }
    }
    // 价格超出网格范围
    return 0;
}

// 监听网格订单成交，完成低买高卖套利
async function runGrid(task) {
    const state = task.runtime;
    const { buyPrice, sellPrice, tokenId } = state;
    const [buyOrderId, sellOrderId] = state.openOrders;

    // 检查必要的运行时数据
    if (!tokenId) {
        console.log(`[网格] 等待初始化 TokenId...`);
        return false;
    }
    if (buyPrice === undefined || sellPrice === undefined) {
        console.log(`[网格] 等待初始化网格价格...`);
        return false;
    }

    const buyOrder = await polyClient.getOrder(buyOrderId);
    const sellOrder = await polyClient.getOrder(sellOrderId);

    if (buyOrder.status === "CANCELED") {
        console.log(`[网格] 买单已取消: ${buyOrderId}`);
        return false;
    }
    // 检查买单是否成交
    if (buyOrder.status === "MATCHED") {
        // 买单已成交，说明价格下跌，在更低价格重新挂买单
        console.log(`[网格] 买单已成交: ${buyOrderId}`);

        // 取消卖单
        await polyClient.cancelOrder(sellOrderId);

        // 计算下一个网格价格
        const nextBuyPrice = getNextPrice(buyPrice, PolySide.BUY);
        const nextSellPrice = getNextPrice(buyPrice, PolySide.SELL);

        if (nextBuyPrice <= 0 || nextSellPrice <= 0) {
            console.log(`[网格] 价格超出网格范围，无法继续交易`);
            return false;
        }

        // 重新挂单
        const gridBuySize = Math.abs(Math.floor(task.tradeUsd / nextBuyPrice));
        const gridSellSize = Math.abs(Math.floor(task.tradeUsd / nextSellPrice));
        console.log(`[网格] 重新挂单: 买入价格=${nextBuyPrice.toFixed(3)}, 数量=${gridBuySize}, 金额=${(gridBuySize * nextBuyPrice).toFixed(2)}U`);
        console.log(`[网格] 重新挂单: 卖出价格=${nextSellPrice.toFixed(3)}, 数量=${gridSellSize}, 金额=${(gridSellSize * nextSellPrice).toFixed(2)}U`);

        console.log(`[网格] 价格动态: [${nextBuyPrice.toFixed(3)} <- ${buyPrice.toFixed(3)} -> ${nextSellPrice.toFixed(3)}]`);

        const newBuyOrder = await polyClient.placeOrder(nextBuyPrice, gridBuySize, PolySide.BUY, tokenId);
        const newSellOrder = await polyClient.placeOrder(nextSellPrice, gridSellSize, PolySide.SELL, tokenId);

        // 更新状态
        state.openOrders = [newBuyOrder.orderID, newSellOrder.orderID];
        state.buyPrice = nextBuyPrice;
        state.sellPrice = nextSellPrice;

        // 记录交易历史
        logTrade(task, PolySide.BUY, buyPrice, nextBuyPrice, gridBuySize, buyOrderId, newBuyOrder.orderID);
        return true;
    }

    if (sellOrder.status === "CANCELED") {
        console.log(`[网格] 卖单已取消: ${sellOrderId}`);
        return false;
    }
    // 检查卖单是否成交
    if (sellOrder.status === "MATCHED") {
        // 卖单已成交，说明价格上涨，在更高价格重新挂卖单
        console.log(`[网格] 卖单已成交: ${sellOrderId}`);

        // 取消买单
        await polyClient.cancelOrder(buyOrderId);

        // 计算下一个网格价格
        const nextBuyPrice = getNextPrice(sellPrice, PolySide.BUY);
        const nextSellPrice = getNextPrice(sellPrice, PolySide.SELL);

        if (nextBuyPrice <= 0 || nextSellPrice <= 0) {
            console.log(`[网格] 价格超出网格范围，无法继续交易`);
            return false;
        }

        // 重新挂单
        const gridBuySize = Math.abs(Math.floor(task.tradeUsd / nextBuyPrice));
        const gridSellSize = Math.abs(Math.floor(task.tradeUsd / nextSellPrice));
        console.log(`[网格] 重新挂单: 买入价格=${nextBuyPrice.toFixed(3)}, 数量=${gridBuySize}, 金额=${gridBuySize * nextBuyPrice}U`);
        console.log(`[网格] 重新挂单: 卖出价格=${nextSellPrice.toFixed(3)}, 数量=${gridSellSize}, 金额=${gridSellSize * nextSellPrice}U`);

        console.log(`[网格] 价格动态: [${nextBuyPrice.toFixed(3)} <- ${sellPrice.toFixed(3)} -> ${nextSellPrice.toFixed(3)}]`);

        const newBuyOrder = await polyClient.placeOrder(nextBuyPrice, gridBuySize, PolySide.BUY, tokenId);
        const newSellOrder = await polyClient.placeOrder(nextSellPrice, gridSellSize, PolySide.SELL, tokenId);

        // 更新状态
        state.openOrders = [newBuyOrder.orderID, newSellOrder.orderID];
        state.buyPrice = nextBuyPrice;
        state.sellPrice = nextSellPrice;

        // 记录交易历史
        logTrade(task, PolySide.SELL, sellPrice, nextSellPrice, gridSellSize, sellOrderId, newSellOrder.orderID);
        return true;
    }
    console.log(`[网格] running...@ ${new Date().toISOString()}`);
    return true;
}

// 将最近 100 次网格交易记录在 runtime.history 中，便于复盘
function logTrade(task, side, tradePrice, nextPrice, orderSize, filledOrderID, newOrderID) {
    const state = task.runtime;
    const entry = {
        ts: new Date().toISOString(),
        side,
        tradePrice,
        nextPrice,
        orderSize,
        filledOrderID,
        newOrderID,
    };
    state.history.push(entry);
    if (state.history.length > 100) {
        state.history = state.history.slice(-100);
    }
    const sideText = side === PolySide.BUY ? "买入" : "卖出";
    console.log(`[历史] ${sideText}成交 @ ${tradePrice.toFixed(3)}, 数量=${orderSize}, 新挂单价格=${nextPrice.toFixed(3)}`);
    console.log(`[历史] 已成交订单: ${filledOrderID}, 新订单: ${newOrderID}`);
}

async function main() {
    console.log("[启动] 单市场网格策略机器人启动中...");
    const ctx = await loadTask();
    const task = ctx.task;

    console.log(`[启动] 任务标签: ${task.label}, 当前状态: ${task.status === 0 ? "未初始化" : "运行中"}`);
    console.log(`[启动] 循环间隔: ${LOOP_MS}ms`);

    while (true) {
        try {
            switch (task.status) {
                case 0:
                    const startResult = await tryStart(task);
                    if (!startResult) {
                        console.log("[主循环] 初始化未完成，等待下次重试...");
                    } else {
                        console.log("[主循环] 初始化成功，下次循环将开始网格交易");
                    }
                    break;
                case 1:
                    await runGrid(task);
                    break;
                default:
                    console.warn(`[主循环] 状态异常: ${task.remark}`);
                    break;
            }
        } catch (error) {
            console.error(`[错误] 执行失败: ${error.message}`);
            console.error(error.stack);
        } finally {
            await saveTask(ctx);
            await wait(LOOP_MS);
        }
    }
}

main().catch((err) => {
    console.error("[致命错误] 程序异常退出:", err);
});
