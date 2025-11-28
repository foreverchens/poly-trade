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

// ========== 配置 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CHAIN_ID = 137;

// ========== 全局状态 ==========
let currentPolyClient = null;
let currentIndex = parseInt(process.env.poly_mnemonic_idx || "0", 10);

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
            const amountToTransfer = (parseFloat(polBalanceFormatted) - 0.005).toFixed(6);
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

    return await lock.acquire("rebuild", async () => {
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
// 初始化PolyClient
getPolyClient();

// rebuildPolyClientSync();
