/**
 * polymarket 经常封禁账号 需要能自动切换账号
 * 同时将旧地址的币划转到新地址
 * 通过助记词 按照推导路径索引 生成多个账号
 * 对外暴露两个函数、一个getPolyClient、
 * 一个rebuildPolyClient
 * getPolyClient 返回一个 PolyClient 实例
 * rebuildPolyClient 基于下一个索引的私钥重建 PolyClient 实例 并返回新的 PolyClient 实例
 *
 * 拥有配置
 *  const mnemonic = process.env.poly_mnemonic;
 *  const poly_mnemonic_idx = process.env.poly_mnemonic_idx;
 *  其中 poly_mnemonic 为助记词
 *  poly_mnemonic_idx 为推导路径索引
 * 当未发生封禁时、getPolyClient 基于配置的助记词和推导路径索引 生成私钥、进而生成 PolyClient 实例
 * 当发生封禁时、上层调用 rebuildPolyClient
 *  1.基于下一个索引 重新生成私钥和地址
 *  2.对新地址 进行初始化赋权、调用addr-init-v5.js 进行初始化赋权
 *  3.对旧地址 进行划转、调用ether-client.js transferPOL 和 transferUSDC 进行划转
 *  4.初始化赋权和划转完成后、创建新的 PolyClient 实例、并返回
 *
 */

import { PolyClient } from "./PolyClient.js";
import { generateAccountFromMnemonic } from "./gen-key.js";
import { transferPOL, transferUSDC } from "./ether-client.js";
import { ethers } from "ethers";
import addrInitV5 from "./addr-init-v5.js";
import AsyncLock from "async-lock";
import { updatePkIdxAndCredsByPkIdx } from "../db/convergence-task-config-repository.js";
import { initCreds } from "./PolyClient.js";
import convergenceTaskConfigs from "../data/convergence-up.config.js";
import logger from "./Logger.js";

// ========== 配置 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CHAIN_ID = 137;

// ========== 全局状态 ==========
let currentPolyClient = null;
let currentIndex = parseInt(process.env.poly_mnemonic_idx || "0", 10);
let clientMap = new Map();
const accountConfigs = convergenceTaskConfigs;
const activeAccountConfigs = accountConfigs.filter((config) => config.task);
activeAccountConfigs.forEach((config) => {
    const client = buildClient(config.task.pkIdx, config.task.creds);
    client.pkIdx = config.task.pkIdx;
    client.taskSlug = config.task.slug;
    client.taskName = config.task.name;
    clientMap.set(config.task.pkIdx, client);
});

const lock = new AsyncLock();
/**
 * 初始化新地址的授权（使用 addr-init-v5.js）
 */
async function initializeAddress(privateKey) {
    await addrInitV5(privateKey);
}

/**
 * 获取当前 PolyClient 实例
 * @returns {PolyClient}
 */
export function getPolyClient() {
    if (currentPolyClient) {
        return currentPolyClient;
    }
    const mnemonic = process.env.poly_mnemonic;
    if (!mnemonic) {
        throw new Error("poly_mnemonic not found in environment variables");
    }
    const account = generateAccountFromMnemonic(mnemonic, currentIndex);
    console.log(`[PolyClient] 使用账户 #${currentIndex}: ${account.address}`);
    currentPolyClient = new PolyClient(account.privateKey);
    return currentPolyClient;
}
/**
 * todo 并发问题、需要加锁
 * 重建 PolyClient 实例（切换到下一个账号）
 * @returns {Promise<PolyClient>}
 */
async function rebuildPolyClient() {
    const mnemonic = process.env.poly_mnemonic;
    if (!mnemonic) {
        throw new Error("poly_mnemonic not found in environment variables");
    }

    // 保存旧账户信息
    const oldClient = currentPolyClient;
    const oldPrivateKey = oldClient?.privateKey;
    const oldAddress = oldClient?.funderAddress;

    // 切换到下一个索引
    currentIndex = currentIndex + 1;
    const newAccount = generateAccountFromMnemonic(mnemonic, currentIndex);

    console.log("\n========== 账号切换 ==========");
    console.log(`[旧账户]: ${oldAddress || "无"}`);
    console.log(`[新账户 #${currentIndex}]: ${newAccount.address}`);

    // 检查旧钱包是否存在
    if (!oldPrivateKey) {
        console.log("\n[警告] 旧钱包不存在，无法进行账号切换");
        throw new Error("旧钱包不存在，终止切换");
    }
    // 1. 从旧钱包划转 1 POL 到新地址（用于初始化 gas 费）
    console.log("\n[步骤 1/4] 划转 1 POL 到新地址...");
    try {
        await transferPOL(oldPrivateKey, newAccount.address, "1");
        console.log(`  ✓ 已划转 1 POL 用于初始化`);
    } catch (error) {
        console.error(`[POL 划转失败]: ${error.message}`);
        throw new Error("无法划转 POL 到新地址，终止切换");
    }
    // 2. 初始化新地址授权
    console.log("\n[步骤 2/4] 初始化新地址授权...");
    try {
        await initializeAddress(newAccount.privateKey);
    } catch (error) {
        console.error(`[授权失败]: ${error.message}`);
        throw new Error("新地址初始化失败，终止切换");
    }
    // 3. 转移 USDC
    console.log("\n[步骤 3/4] 转移 USDC...");
    try {
        const oldClientInstance = new PolyClient(oldPrivateKey);
        const usdcBalance = await oldClientInstance.getUsdcEBalance();
        const usdcBalanceNum = parseFloat(usdcBalance);

        if (usdcBalanceNum > 0.1) {
            const amountToTransfer = usdcBalanceNum.toFixed(6);
            await transferUSDC(oldPrivateKey, newAccount.address, amountToTransfer);
            console.log(`  ✓ USDC 转移成功: ${amountToTransfer}`);
        } else {
            console.log(`  - USDC 余额太少，跳过`);
        }
    } catch (error) {
        console.error(`[USDC 转移失败]: ${error.message}`);
    }
    console.log("\n[步骤 4/4] 转移剩余 POL...");
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
        const polBalance = await provider.getBalance(oldAddress);
        const polBalanceFormatted = ethers.utils.formatEther(polBalance);

        if (parseFloat(polBalanceFormatted) > 0.01) {
            // 预留 0.005 POL 用于可能的其他操作
            const amountToTransfer = (parseFloat(polBalanceFormatted) - 0.01).toFixed(6);
            await transferPOL(oldPrivateKey, newAccount.address, amountToTransfer);
            console.log(`  ✓ POL 转移成功: ${amountToTransfer}`);
        } else {
            console.log(`  - POL 余额太少，跳过`);
        }
    } catch (error) {
        console.error(`[POL 转移失败]: ${error.message}`);
    }
    // 5. 创建新的 PolyClient 实例
    currentPolyClient = new PolyClient(newAccount.privateKey);
    console.log("\n========== 切换完成 ==========\n");
    // 更新内存中的环境变量
    process.env.poly_mnemonic_idx = currentIndex.toString();
    return currentPolyClient;
}

/**
 * 并发安全的重建PolyClient实例
 * 当多个线程 同时调用rebuildPolyClientSync时
 * 需要保障只有一个线程真正执行重建操作、其他线程同步等待、最终所有线程都能拿到重建后的PolyClient实例、
 * 如果重建失败、直接结束进程
 */
export async function rebuildPolyClientSync() {
    // 记录触发重建时的地址，用于判断是否已被其他调用重建过
    const failedAddress = currentPolyClient?.funderAddress;

    return lock.acquire("rebuild", async () => {
        try {
            // 如果地址已经改变，说明已经被其他并发调用重建过了，直接返回新实例
            if (currentPolyClient?.funderAddress !== failedAddress) {
                console.log("[并发重建] 账号已被其他调用重建，直接返回新实例");
                return currentPolyClient;
            }

            // 执行真正的重建操作
            console.log("[并发重建] 开始执行账号重建...");
            const result = await rebuildPolyClient();
            console.log("[并发重建] 账号重建完成");
            return result;
        } catch (error) {
            console.error("[致命错误] PolyClient 重建失败:", error.message);
            console.error(error.stack);
            process.exit(1);
        }
    });
}

/**
 *  基于助记词和索引 生成账户
 * @param idx
 * @returns {{address: string, privateKey: string, path: string}}
 */
export function getAccount(idx = currentIndex) {
    return generateAccountFromMnemonic(process.env.poly_mnemonic, idx);
}

/**
 * 基于助记词和索引 生成账户 并获取账户的USDC余额
 * @param idx
 * @returns {{address: string, privateKey: string, path: string, usdcBalance: string}}
 */
export async function getAccountWithBalance(idx = currentIndex) {
    const account = getAccount(idx);
    const client = new PolyClient(account.privateKey);
    const usdcBalance = await client.getUsdcEBalance();
    return {
        ...account,
        usdcBalance,
    };
}

/**
 * 基于助记词和索引以及creds 生成PolyClient实例 并缓存
 * @param {number} idx
 * @param {JSON} creds
 * @returns {PolyClient}
 */
export function buildClient(idx, creds) {
    if (clientMap.has(idx)) {
        return clientMap.get(idx);
    }
    const account = getAccount(idx);
    const client = new PolyClient(account.privateKey, creds);
    clientMap.set(idx, client);
    return client;
}

export async function nextClient(idx, oldClient) {
    try {
        const oldAddress = oldClient.funderAddress;
        // 删除旧的缓存
        clientMap.delete(idx);
        // 将idx+1 得到新的私钥和地址、
        const newAccount = getAccount(idx + 1);
        logger.info("\n========== 账号切换 ==========");
        logger.info(`[旧账户]: ${oldAddress || "无"}`);
        logger.info(`[新账户 #${idx + 1}]: ${newAccount.address}`);

        // 转移1POL到新地址、用于初始化gas费
        logger.info("[步骤 1/8] 划转 1 POL 到新地址...");
        await transferPOL(oldClient.privateKey, newAccount.address, "1");
        logger.info("  ✓ 已划转 1 POL 用于初始化");
        // 初始化新地址授权
        logger.info("[步骤 2/8] 初始化新地址授权...");
        await initializeAddress(newAccount.privateKey);
        logger.info("  ✓ 新地址授权初始化完成");
        // 转移USDC
        logger.info("[步骤 3/8] 转移 USDC...");
        const usdcBalance = await oldClient.getUsdcEBalance();
        const usdcBalanceNum = parseFloat(usdcBalance);
        if (usdcBalanceNum > 0.1) {
            const amountToTransfer = usdcBalanceNum.toFixed(6);
            await transferUSDC(oldClient.privateKey, newAccount.address, amountToTransfer);
            logger.info(`  ✓ USDC 转移成功: ${amountToTransfer}`);
        }else{
            logger.info("  - USDC 余额太少，跳过处理");
        }
        // 转移剩余POL
        logger.info("[步骤 4/8] 转移剩余 POL...");
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
        const polBalance = await provider.getBalance(oldAddress);
        const polBalanceFormatted = ethers.utils.formatEther(polBalance);
        if (parseFloat(polBalanceFormatted) > 0.01) {
            const amountToTransfer = (parseFloat(polBalanceFormatted) - 0.01).toFixed(6);
            await transferPOL(oldClient.privateKey, newAccount.address, amountToTransfer);
            logger.info(`  ✓ POL 转移成功: ${amountToTransfer}`);
        }else{
            logger.info("  - POL 余额太少，跳过处理");
        }
        // 使用新的私钥和地址 生成新的creds
        logger.info("[步骤 5/8] 生成新的creds...");
        const creds = await initCreds(newAccount.privateKey);
        logger.info("  ✓ creds 生成完成");
        // 生成新的PolyClient实例
        logger.info("[步骤 6/8] 生成新的PolyClient实例...");
        const client = new PolyClient(newAccount.privateKey, creds);
        logger.info("  ✓ PolyClient 实例生成完成");
        // 更新缓存
        logger.info("[步骤 7/8] 更新缓存...");
        clientMap.set(idx + 1, client);
        // 更新DB中的索引
        logger.info("[步骤 8/8] 更新DB中的索引和creds...");
        await updatePkIdxAndCredsByPkIdx(idx, idx + 1, creds);
        logger.info("  ✓ DB 更新完成");
        logger.info("\n========== 账号切换完成 ==========\n");
        return client;
    } catch (error) {
        logger.error("[致命错误] PolyClient 切换失败:", error.message);
        logger.error(error.stack);
        return null;
    }
}

export async function getDefaultClient() {
    const config = activeAccountConfigs[0];
    const client = buildClient(config .task.pkIdx, config.task.creds);
    logger.info(`使用账户—> #${config.task.pkIdx}  ${client.funderAddress}`);
    return client;
}

export const activeClientMap = () => {
    return clientMap
}
// 初始化PolyClient
// console.log(getAccount(301));
// var polyClient = buildClient(200,null);
// nextClient(200,polyClient)
