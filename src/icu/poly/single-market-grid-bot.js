import { readFile, writeFile } from "fs/promises";
import { setTimeout as wait } from "timers/promises";
import { PolyClient, PolySide } from "./core/PolyClient.js";

const DATA_PATH = new URL("./data/short-strangle-grid.data.json", import.meta.url);
const GRID = [1, 0.99, 0.95, 0.93, 0.9, 0.86, 0.81, 0.75, 0.68, 0.55, 0];
const LOOP_MS = 1_000 * 60;

const polyClient = new PolyClient(true);

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

async function tryStart(task) {
    console.log("[初始化] 开始初始化任务...");
    const { marketId, tradeUsd, initPosition } = task;

    console.log(`[初始化] 正在获取市场信息: ${marketId}`);
    const markets = await polyClient.getMarketByConditionId(marketId);
    if (!markets || markets.length === 0) {
        console.log(`[初始化] 市场不存在: ${marketId}`);
        return false;
    }

    const market = markets[0];
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

    // 基于 bestAskPrice 进行初始买入
    const initSize = Math.abs(Math.floor(initPosition * tradeUsd / bestAskPrice));
    console.log(`[初始化] 初始买入: 价格=${bestAskPrice.toFixed(3)}, 数量=${initSize}, 金额=${initSize * bestAskPrice}U`);

    const initOrder = await polyClient.placeOrder(bestAskPrice, initSize, PolySide.BUY, tokenId);
    console.log(`[初始化] 初始买入订单已提交: ${initOrder.orderID}`);

    // 计算网格价格：上挂卖单（更高价格），下挂买单（更低价格）
    const sellPrice = getNextPrice(bestAskPrice, PolySide.SELL);
    const buyPrice = getNextPrice(bestAskPrice, PolySide.BUY);

    if (sellPrice === undefined || buyPrice === undefined) {
        console.log(`[初始化] 无法计算网格价格 (sellPrice: ${sellPrice}, buyPrice: ${buyPrice})`);
        return false;
    }

    // 计算网格订单数量
    const gridBuySize = Math.abs(Math.floor(tradeUsd / buyPrice));
    const gridSellSize = Math.abs(Math.floor(tradeUsd / sellPrice));
    console.log(`[初始化] 网格买单: 价格=${buyPrice.toFixed(3)}, 数量=${gridBuySize}, 金额=${gridBuySize * buyPrice}U`);
    console.log(`[初始化] 网格卖单: 价格=${sellPrice.toFixed(3)}, 数量=${gridSellSize}, 金额=${gridSellSize * sellPrice}U`);

    // 提交网格挂单
    const buyOrder = await polyClient.placeOrder(buyPrice, gridBuySize, PolySide.BUY, tokenId);
    const sellOrder = await polyClient.placeOrder(sellPrice, gridSellSize, PolySide.SELL, tokenId);
    console.log(`[初始化] 网格买入挂单已提交: ${buyOrder.orderID}`);
    console.log(`[初始化] 网格卖出挂单已提交: ${sellOrder.orderID}`);

    task.runtime = {
        tokenId: tokenId,
        buyPrice: buyPrice,
        sellPrice: sellPrice,
        position: Number(initSize).toFixed(2),
        initOrder: initOrder.orderID,
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
    for (let i = 1; i < GRID.length; i++) {
        if (curPrice <= GRID[i - 1] && curPrice >= GRID[i]) {
            if (side === PolySide.BUY) {
                return GRID[i];
            } else {
                return GRID[i - 1];
            }
        }
    }
    // 价格超出网格范围
    return undefined;
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

    // 检查买单是否成交
    if (!buyOrder) {
        // 买单已成交，说明价格下跌，在更低价格重新挂买单
        console.log(`[网格] 买单已成交: ${buyOrderId}`);

        // 取消卖单
        await polyClient.cancelOrder(sellOrderId);

        // 计算下一个网格价格
        const nextBuyPrice = getNextPrice(buyPrice, PolySide.BUY);
        const nextSellPrice = getNextPrice(sellPrice, PolySide.SELL);

        if (nextBuyPrice === undefined || nextSellPrice === undefined) {
            console.log(`[网格] 价格超出网格范围，无法继续交易`);
            return false;
        }

        // 重新挂单
        const gridBuySize = Math.abs(Math.floor(task.tradeUsd / nextBuyPrice));
        const gridSellSize = Math.abs(Math.floor(task.tradeUsd / nextSellPrice));
        console.log(`[网格] 重新挂单: 买入价格=${nextBuyPrice.toFixed(3)}, 数量=${gridBuySize}, 金额=${gridBuySize * nextBuyPrice}U`);
        console.log(`[网格] 重新挂单: 卖出价格=${nextSellPrice.toFixed(3)}, 数量=${gridSellSize}, 金额=${gridSellSize * nextSellPrice}U`);

        const newBuyOrder = await polyClient.placeOrder(nextBuyPrice, gridBuySize, PolySide.BUY, tokenId);
        const newSellOrder = await polyClient.placeOrder(nextSellPrice, gridSellSize, PolySide.SELL, tokenId);
        console.log(`[网格] 重新挂单: 买入订单已提交: ${newBuyOrder.orderID}`);
        console.log(`[网格] 重新挂单: 卖出订单已提交: ${newSellOrder.orderID}`);

        // 更新状态
        state.openOrders = [newBuyOrder.orderID, newSellOrder.orderID];
        state.buyPrice = nextBuyPrice;
        state.sellPrice = nextSellPrice;

        // 记录交易历史
        logTrade(task, PolySide.BUY, buyPrice, nextBuyPrice, gridBuySize, buyOrderId, newBuyOrder.orderID);
        return true;
    }

    // 检查卖单是否成交
    if (!sellOrder) {
        // 卖单已成交，说明价格上涨，在更高价格重新挂卖单
        console.log(`[网格] 卖单已成交: ${sellOrderId}`);

        // 取消买单
        await polyClient.cancelOrder(buyOrderId);

        // 计算下一个网格价格
        const nextBuyPrice = getNextPrice(buyPrice, PolySide.BUY);
        const nextSellPrice = getNextPrice(sellPrice, PolySide.SELL);

        if (nextBuyPrice === undefined || nextSellPrice === undefined) {
            console.log(`[网格] 价格超出网格范围，无法继续交易`);
            return false;
        }

        // 重新挂单
        const gridBuySize = Math.abs(Math.floor(task.tradeUsd / nextBuyPrice));
        const gridSellSize = Math.abs(Math.floor(task.tradeUsd / nextSellPrice));
        console.log(`[网格] 重新挂单: 买入价格=${nextBuyPrice.toFixed(3)}, 数量=${gridBuySize}, 金额=${gridBuySize * nextBuyPrice}U`);
        console.log(`[网格] 重新挂单: 卖出价格=${nextSellPrice.toFixed(3)}, 数量=${gridSellSize}, 金额=${gridSellSize * nextSellPrice}U`);

        const newBuyOrder = await polyClient.placeOrder(nextBuyPrice, gridBuySize, PolySide.BUY, tokenId);
        const newSellOrder = await polyClient.placeOrder(nextSellPrice, gridSellSize, PolySide.SELL, tokenId);
        console.log(`[网格] 重新挂单: 买入订单已提交: ${newBuyOrder.orderID}`);
        console.log(`[网格] 重新挂单: 卖出订单已提交: ${newSellOrder.orderID}`);

        // 更新状态
        state.openOrders = [newBuyOrder.orderID, newSellOrder.orderID];
        state.buyPrice = nextBuyPrice;
        state.sellPrice = nextSellPrice;

        // 记录交易历史
        logTrade(task, PolySide.SELL, sellPrice, nextSellPrice, gridSellSize, sellOrderId, newSellOrder.orderID);
        return true;
    }

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
        position: state.position,
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
                    console.warn(`[主循环] 未知状态: ${task.status}`);
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
