import {readFile, writeFile} from "fs/promises";
import {setTimeout as wait} from "timers/promises";
import {fileURLToPath} from "url";
import {PolyClient, PolySide} from "./core/PolyClient.js";

const FILE_ID = fileURLToPath(import.meta.url);
const DATA_PATH = new URL("./data/short-strangle-grid.data.json", import.meta.url);
const GRID = [1, 0.99, 0.95, 0.93, 0.9, 0.86, 0.81, 0.75, 0.68, 0.55, 0];
const LOOP_MS = 5_000;

const polyClient = new PolyClient(true);

// 读取 tasks 节点，将静态配置与 runtime 状态放在同一 JSON 中
/**
 *
 * @returns {Promise<{blob: ({tasks}|any), task:     {
 *       "label": "btc-102k-106k-grid",
 *       "slug": ""
 *       "lowMarketId": "TOKEN_ID_102K_YES",
 *       "highMarketId": "TOKEN_ID_106K_NO",
 *       "lowMarketSide": 0,
 *       "tradeUsd": 10,
 *       "initPosition":[10,10]
 *       "status":[0,1],
 *       "dryRun": true}}>}
 */
async function loadTask() {
    const blob = JSON.parse(await readFile(DATA_PATH, "utf8"));
    if (!blob?.tasks) throw new Error("tasks missing in short-strangle-grid.data.json");
    const task = blob.tasks[0];
    task.runtime = task.runtime ?? {};
    task.runtime.yesUsd = Number(task.runtime.yesUsd ?? 0);
    task.runtime.noUsd = Number(task.runtime.noUsd ?? 0);
    task.runtime.lastPrice = typeof task.runtime.lastPrice === "number" ? task.runtime.lastPrice : null;
    task.runtime.cursor = Number.isInteger(task.runtime.cursor) ? task.runtime.cursor : 0;
    task.runtime.fills = GRID.reduce((acc, level) => {
        const key = level.toFixed(4);
        acc[key] = Boolean(task.runtime.fills?.[key]);
        return acc;
    }, {});
    task.runtime.history = Array.isArray(task.runtime.history) ? task.runtime.history : [];
    task.runtime.mock = Array.isArray(task.runtime.mock) ? task.runtime.mock : [];
    return {blob, task};
}

async function saveTask(ctx) {
    await writeFile(DATA_PATH, `${JSON.stringify(ctx.blob, null, 2)}\n`, "utf8");
}

// 获取低价位市场的 YES 价格（dryRun 时循环使用 runtime.mock）
async function fetchPrice(task, state, live) {
    if (task.dryRun) {
        if (state.mock.length === 0) throw new Error("runtime.mock must contain dry-run prices");
        const price = Number(state.mock[state.cursor % state.mock.length]);
        state.cursor += 1;
        return {price};
    }
    if (!live.client) {
        if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing for live mode");
        live.client = new PolyClient();
    }
    const raw = await live.client.getPrice(PolySide.BUY, task.lowMarketId);
    return {price: Number(raw)};
}

async function tryStart(task) {
    const {slug, lowMarketId, highMarketId, tradeUsd} = task;
    const runtime = task.runtime;
    let event = await polyClient.getEventBySlug(slug);
    if (!event) {
        return null;
    }
    let lowTokenId, highTokenId;
    event.markets.forEach(ele => {
        if (ele.conditionId === lowMarketId) {
            lowTokenId = JSON.parse(ele.clobTokenIds)[0];
            console.log(`低区:${ele.slug}`)
        } else if (ele.conditionId === highMarketId) {
            highTokenId = JSON.parse(ele.clobTokenIds)[1];
            console.log(`高区:${ele.slug}`)
        }
    })
    if (!(lowTokenId && highTokenId)) {
        return null;
    }
    runtime.lowTokenId = lowTokenId;
    runtime.highTokenId = highTokenId;
    // 初始建仓 initPosition
    let [lowSize, highSize] = task.initPosition;
    let [lowBidPrice, lowAskPrice] = await polyClient.fetchBestPrice(lowTokenId);
    let lowOrder = await polyClient.placeOrder(lowAskPrice, lowSize * tradeUsd, PolySide.BUY, lowTokenId);
    let [highBidPrice, highAskPrice] = await polyClient.fetchBestPrice(highTokenId);
    let highOrder = await polyClient.placeOrder(highAskPrice, highSize * tradeUsd, PolySide.BUY, highTokenId);
    runtime.initOrders = [lowOrder.orderID, highOrder.orderID];
    runtime.buyPrice = getNextPrice(lowAskPrice, PolySide.BUY);
    runtime.sellPrice = getNextPrice(lowAskPrice, PolySide.SELL);
    task.status = 1;
}

/**
 * todo
 * 根据当前价格和方向、获取下一交易价格
 * @param curPrice
 * @param side
 */
function getNextPrice(curPrice, side) {

}

// 判断 YES 价格是否在网格点之间穿越，决定是否交换 YES/NO 资金
async function runGrid(task) {
    // const state = task.runtime;
    // const prev = state.lastPrice;
    // if (!Number.isFinite(price)) throw new Error("invalid price from feed");
    // state.lastPrice = price;
    // if (prev === null) return;
    // for (const level of GRID) {
    //     const key = level.toFixed(4);
    //     const crossedDown = prev > level && price <= level && !state.fills[key];
    //     const crossedUp = prev < level && price >= level && state.fills[key];
    //     if (crossedDown) swap("sell-yes", level, task);
    //     else if (crossedUp) swap("buy-yes", level, task);
    // }
}

// 仅做资金搬运，不实际下单；忽略手续费、滑点、风控
function swap(kind, level, task) {
    const state = task.runtime;
    const key = level.toFixed(4);
    if (kind === "sell-yes" && state.yesUsd >= task.tradeUsd) {
        state.yesUsd = Number((state.yesUsd - task.tradeUsd).toFixed(2));
        state.noUsd = Number((state.noUsd + task.tradeUsd).toFixed(2));
        state.fills[key] = true;
        logSwap(kind, level, task);
    } else if (kind === "buy-yes" && state.noUsd >= task.tradeUsd) {
        state.noUsd = Number((state.noUsd - task.tradeUsd).toFixed(2));
        state.yesUsd = Number((state.yesUsd + task.tradeUsd).toFixed(2));
        state.fills[key] = false;
        logSwap(kind, level, task);
    }
}

// 将最近 100 次网格触发记录在 runtime.history 中，便于复盘
function logSwap(kind, level, task) {
    const entry = {
        ts: new Date().toISOString(),
        kind,
        level,
        yesUsd: task.runtime.yesUsd,
        noUsd: task.runtime.noUsd,
    };
    task.runtime.history.push(entry);
    if (task.runtime.history.length > 100) {
        task.runtime.history = task.runtime.history.slice(-100);
    }
    console.log(`[${entry.ts}] ${kind}@${level.toFixed(4)} | yes=${entry.yesUsd} no=${entry.noUsd}`);
}

async function main() {
    const ctx = await loadTask();
    const task = ctx.task;
    while (true) {
        try {
            switch (task.status) {
                case 0:
                    await tryStart(task);
                case 1:
                    await runGrid(task);
                    break;
            }
        } catch (error) {
            console.error("tick failed:", error.message);
        } finally {
            await saveTask(ctx);
            await wait(LOOP_MS);
        }
    }
}

/**
 *     {
 *       "label": "btc-102k-106k-grid",
 *       "lowMarketId": "TOKEN_ID_102K_YES",
 *       "highMarketId": "TOKEN_ID_106K_NO",
 *       "lowMarketSide": 0,
 *       "tradeUsd": 10,
 *       "dryRun": true,
 *      }
 */
main().catch((err) => {
    console.error(err);
});
