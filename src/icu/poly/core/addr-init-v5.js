// Requires: ethers v5
// Usage: node src/icu/poly/core/addr-init-v5.js

import 'dotenv/config';
import { ethers } from "ethers";
import { getGasPrice } from "./ether-client.js";
import { generateAccountFromMnemonic } from "./gen-key.js";

// ========== 环境变量 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CHAIN_ID = 137; // Polygon

// ========== 目标合约与地址 ==========
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC.e
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // CTF(ERC1155)

const TARGETS = [
    { name: "CTF Exchange", addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
    { name: "Neg Risk CTF Exchange", addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
    { name: "Neg Risk Adapter", addr: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
];

// ========== ABI ==========
const ERC20_ABI = [
    "function approve(address spender, uint256 value) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];

// ========== 重试机制辅助函数 ==========
/**
 * 带重试的交易发送函数
 * @param {Function} txFn - 返回 Promise<TransactionResponse> 的函数
 * @param {string} operationName - 操作名称（用于日志）
 * @param {ethers.BigNumber} initialGasLimit - 初始 gas limit
 * @param {number} maxRetries - 最大重试次数（默认 3）
 * @returns {Promise<ethers.ContractReceipt>} 交易收据
 */
async function sendTxWithRetry(txFn, operationName, initialGasLimit, maxRetries = 3) {
    let currentGasLimit = initialGasLimit;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[${operationName}] 尝试 ${attempt}/${maxRetries}, Gas Limit: ${currentGasLimit.toString()}`);
            const tx = await txFn(currentGasLimit);
            console.log(`[${operationName}] 提交 tx: ${tx.hash}`);
            const rcpt = await tx.wait();
            console.log(`[${operationName}] 成功，区块: ${rcpt.blockNumber}, Gas 使用: ${rcpt.gasUsed.toString()}`);
            return rcpt;
        } catch (error) {
            lastError = error;
            console.error(`[${operationName}] 尝试 ${attempt}/${maxRetries} 失败: ${error.message}`);

            if (attempt < maxRetries) {
                // 每次重试时增加 20% gas limit
                currentGasLimit = currentGasLimit.mul(120).div(100);
                console.log(`[${operationName}] 下次重试将使用 Gas Limit: ${currentGasLimit.toString()}`);
                // 等待一小段时间再重试
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    // 所有重试都失败
    throw new Error(`${operationName} 在 ${maxRetries} 次尝试后仍然失败。最后错误: ${lastError.message}`);
}

async function addrInitV5(privateKey) {
    // v5 Provider 实例化
    if (!privateKey) {
        console.error("请设置 PRIVATE_KEY 环境变量");
        return;
    }
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const wallet = new ethers.Wallet(privateKey, provider);
    const owner = wallet.address;

    console.log(`使用地址: ${owner}`);

    try {
        const polBal = await provider.getBalance(owner);
        // v5 使用 utils.formatEther
        console.log(`POL 余额: ${ethers.utils.formatEther(polBal)} POL`);
    } catch (err) {
        console.error("获取 POL 余额失败，请检查 RPC 是否可用:", err.message);
        // 不阻断后续逻辑，但通常没余额也发不了交易
    }

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

    // 打印 USDC 小数位
    const usdcDecimals = await usdc.decimals().catch(() => 6);
    console.log(`USDC decimals = ${usdcDecimals}`);

    // 获取推荐的 gas 价格
    const gasPrice = await getGasPrice();
    console.log(`使用 Gas 价格 - MaxFee: ${ethers.utils.formatUnits(gasPrice.maxFeePerGas, "gwei")} Gwei, MaxPriorityFee: ${ethers.utils.formatUnits(gasPrice.maxPriorityFeePerGas, "gwei")} Gwei`);

    for (const t of TARGETS) {
        console.log(`\n=== 处理目标：${t.name} (${t.addr}) ===`);

        // 1) USDC 无限额授权
        const curAllowance = await usdc.allowance(owner, t.addr);
        console.log(`当前 USDC allowance: ${curAllowance.toString()}`);

        // v5 使用 BigNumber 比较：allowance < MaxUint256 / 2
        if (curAllowance.lt(ethers.constants.MaxUint256.div(2))) {
            console.log("发送 USDC approve(MaxUint256) 交易...");

            // 估算 gas limit 并上浮 50%
            let gasLimit;
            try {
                const estimatedGas = await usdc.estimateGas.approve(t.addr, ethers.constants.MaxUint256);
                gasLimit = estimatedGas.mul(150).div(100); // 上浮 50%
                console.log(`[Gas Limit] 估算值: ${estimatedGas.toString()}, 使用值(上浮50%): ${gasLimit.toString()}`);
            } catch (error) {
                console.warn(`⚠️ Gas 估算失败，使用默认值: ${error.message}`);
                gasLimit = ethers.BigNumber.from(100000); // 备用默认值
                console.log(`[Gas Limit] 使用默认值: ${gasLimit.toString()}`);
            }

            // 使用重试机制发送授权
            try {
                await sendTxWithRetry(
                    (gasLimitParam) => usdc.approve(t.addr, ethers.constants.MaxUint256, {
                        maxFeePerGas: gasPrice.maxFeePerGas,
                        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
                        gasLimit: gasLimitParam,
                        type: 2  // EIP-1559 transaction
                    }),
                    "USDC approve",
                    gasLimit,
                    3
                );
            } catch (error) {
                console.error(`USDC approve 最终失败: ${error.message}`);
                throw error;
            }
        } else {
            console.log("已是大额度授权，跳过 USDC approve。");
        }

        // 2) ERC1155 setApprovalForAll(true)
        const approved = await ctf.isApprovedForAll(owner, t.addr);
        console.log(`当前 ERC1155 isApprovedForAll: ${approved}`);

        if (!approved) {
            console.log("发送 setApprovalForAll(true) 交易...");

            // 估算 gas limit 并上浮 50%
            let gasLimit;
            try {
                const estimatedGas = await ctf.estimateGas.setApprovalForAll(t.addr, true);
                gasLimit = estimatedGas.mul(150).div(100); // 上浮 50%
                console.log(`[Gas Limit] 估算值: ${estimatedGas.toString()}, 使用值(上浮50%): ${gasLimit.toString()}`);
            } catch (error) {
                console.warn(`⚠️ Gas 估算失败，使用默认值: ${error.message}`);
                gasLimit = ethers.BigNumber.from(50000); // 备用默认值
                console.log(`[Gas Limit] 使用默认值: ${gasLimit.toString()}`);
            }

            // 使用重试机制发送交易
            try {
                await sendTxWithRetry(
                    (gasLimitParam) => ctf.setApprovalForAll(t.addr, true, {
                        maxFeePerGas: gasPrice.maxFeePerGas,
                        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
                        gasLimit: gasLimitParam,
                        type: 2  // EIP-1559 transaction
                    }),
                    "setApprovalForAll",
                    gasLimit,
                    3
                );
            } catch (error) {
                console.error(`setApprovalForAll 最终失败: ${error.message}`);
                throw error;
            }
        } else {
            console.log("已是 ERC1155 批准状态，跳过 setApprovalForAll。");
        }
    }

    console.log("\n全部处理完成。");
}



// const mnemonic = process.env.poly_mnemonic || "";
// let curIdx = parseInt(process.env.poly_mnemonic_idx || "0", 10);
// const account = generateAccountFromMnemonic(mnemonic, curIdx);
// const pk = account.privateKey;
// addrInitV5(pk).catch((e) => {
//     console.error("执行脚本出错:", e);
//     process.exit(1);
// });


export default addrInitV5;
