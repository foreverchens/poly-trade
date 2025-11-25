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

// ========== 配置 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CHAIN_ID = 137;
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const TARGETS = [
    { name: "CTF Exchange", addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
    { name: "Neg Risk CTF Exchange", addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
    { name: "Neg Risk Adapter", addr: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
];

const ERC20_ABI = [
    "function approve(address spender, uint256 value) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) view returns (bool)",
];

// ========== 全局状态 ==========
let currentPolyClient = null;
let currentIndex = parseInt(process.env.poly_mnemonic_idx || "0", 10);

/**
 * 初始化新地址的授权（基于 addr-init-v5.js 的逻辑）
 */
async function initializeAddress(privateKey) {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const pk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`[初始化地址]: ${wallet.address}`);

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

    for (const t of TARGETS) {
        console.log(`[授权目标]: ${t.name}`);

        // 1) USDC approve
        const curAllowance = await usdc.allowance(wallet.address, t.addr);
        if (curAllowance.lt(ethers.constants.MaxUint256.div(2))) {
            const tx = await usdc.approve(t.addr, ethers.constants.MaxUint256);
            await tx.wait();
            console.log(`  ✓ USDC approve 完成`);
        } else {
            console.log(`  ✓ USDC 已授权`);
        }

        // 2) ERC1155 setApprovalForAll
        const approved = await ctf.isApprovedForAll(wallet.address, t.addr);
        if (!approved) {
            const tx2 = await ctf.setApprovalForAll(t.addr, true);
            await tx2.wait();
            console.log(`  ✓ ERC1155 approve 完成`);
        } else {
            console.log(`  ✓ ERC1155 已授权`);
        }
    }

    console.log(`[地址初始化完成]`);
}

/**
 * 获取当前 PolyClient 实例
 * @returns {PolyClient}
 */
export function getPolyClient(mock = false) {
    if (!currentPolyClient) {
        const mnemonic = process.env.poly_mnemonic;
        if (!mnemonic) {
            throw new Error("poly_mnemonic not found in environment variables");
        }

        const account = generateAccountFromMnemonic(mnemonic, currentIndex);
        console.log(`[PolyClient] 使用账户 #${currentIndex}: ${account.address}`);
        currentPolyClient = new PolyClient(account.privateKey, mock);
    }

    return currentPolyClient;
}

/**
 * 重建 PolyClient 实例（切换到下一个账号）
 * @returns {Promise<PolyClient>}
 */
export async function rebuildPolyClient() {
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

    // 1. 初始化新地址授权
    console.log("\n[步骤 1/3] 初始化新地址授权...");
    try {
        await initializeAddress(newAccount.privateKey);
    } catch (error) {
        console.error(`[授权失败]: ${error.message}`);
        throw new Error("新地址初始化失败，终止切换");
    }

    // 2. 转移 POL
    if (oldPrivateKey) {
        console.log("\n[步骤 2/3] 转移 POL...");
        try {
            const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
            const polBalance = await provider.getBalance(oldAddress);
            const polBalanceFormatted = ethers.utils.formatEther(polBalance);

            if (parseFloat(polBalanceFormatted) > 0.01) {
                // 预留 0.005 POL 用于可能的其他操作
                const amountToTransfer = (
                    parseFloat(polBalanceFormatted) - 0.005
                ).toFixed(6);
                await transferPOL(oldPrivateKey, newAccount.address, amountToTransfer);
                console.log(`  ✓ POL 转移成功: ${amountToTransfer}`);
            } else {
                console.log(`  - POL 余额太少，跳过`);
            }
        } catch (error) {
            console.error(`[POL 转移失败]: ${error.message}`);
        }

        // 3. 转移 USDC
        console.log("\n[步骤 3/3] 转移 USDC...");
        try {
            const oldClientInstance = new PolyClient(oldPrivateKey);
            const usdcBalance = await oldClientInstance.getUsdcEBalance();
            const usdcBalanceNum = parseFloat(usdcBalance);

            if (usdcBalanceNum > 0.1) {
                // 预留 0.05 USDC
                const amountToTransfer = (usdcBalanceNum - 0.05).toFixed(6);
                await transferUSDC(oldPrivateKey, newAccount.address, amountToTransfer);
                console.log(`  ✓ USDC 转移成功: ${amountToTransfer}`);
            } else {
                console.log(`  - USDC 余额太少，跳过`);
            }
        } catch (error) {
            console.error(`[USDC 转移失败]: ${error.message}`);
        }
    }

    // 4. 创建新的 PolyClient 实例
    currentPolyClient = new PolyClient(newAccount.privateKey);

    console.log("\n========== 切换完成 ==========\n");

    // 更新内存中的环境变量
    process.env.poly_mnemonic_idx = currentIndex.toString();

    return currentPolyClient;
}

