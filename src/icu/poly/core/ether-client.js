// Requires: ethers v5
// Usage: 基于ethers v5.7.2实现POL和USDC.e的转账及余额查询

import 'dotenv/config';
import { ethers } from "ethers";

// ========== 常量定义 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CHAIN_ID = 137; // Polygon
const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC.e
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // CTF(ERC1155)
const GAS_STATION_API = "https://gasstation.polygon.technology/v2";

// ERC20 ABI - 仅包含需要的方法
const ERC20_ABI = [
    "function transfer(address to, uint256 value) external returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

// CTF ABI - Polymarket Conditional Tokens Framework
const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
];

// ========== 工具函数 ==========

/**
 * 从 Polygon Gas Station 获取推荐的 gas 价格
 * @returns {Promise<{maxFeePerGas: ethers.BigNumber, maxPriorityFeePerGas: ethers.BigNumber}>}
 */
export async function getGasPrice() {
    try {
        const response = await fetch(GAS_STATION_API);
        const data = await response.json();

        // 使用 standard 级别的 gas 价格
        const maxFeePerGas = ethers.utils.parseUnits(
            Math.ceil(data.standard.maxFee).toString(),
            "gwei"
        );
        const maxPriorityFeePerGas = ethers.utils.parseUnits(
            Math.ceil(data.standard.maxPriorityFee).toString(),
            "gwei"
        );

        console.log(`[Gas Station API] MaxFee: ${Math.ceil(data.standard.maxFee)} Gwei, MaxPriorityFee: ${Math.ceil(data.standard.maxPriorityFee)} Gwei`);

        return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
        console.warn('⚠️ Gas Station API 失败，使用备用方案:', error.message);
        // 备用方案：使用固定的安全值
        const maxFeePerGas = ethers.utils.parseUnits("50", "gwei");
        const maxPriorityFeePerGas = ethers.utils.parseUnits("30", "gwei");
        return { maxFeePerGas, maxPriorityFeePerGas };
    }
}

/**
 * 获取provider和wallet实例
 * @param {string} privateKey - 私钥（可选，如果不提供则从环境变量读取）
 * @returns {Object} { provider, wallet }
 */
function getProviderAndWallet(privateKey = null) {
    let pk = privateKey || process.env.PRIVATE_KEY;

    if (!pk) {
        throw new Error("请设置 PRIVATE_KEY 环境变量或传入私钥参数");
    }

    // 处理私钥：确保有0x前缀
    if (pk && !pk.startsWith('0x')) {
        pk = '0x' + pk;
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const wallet = new ethers.Wallet(pk, provider);

    return { provider, wallet };
}

// ========== POL相关功能 ==========

/**
 * 获取POL余额
 * @param {string} address - 要查询的地址
 * @param {string} privateKey - 私钥（可选）
 * @returns {Promise<string>} 格式化后的余额（单位：POL）
 */
export async function getPOLBalance(address, privateKey = null) {
    const { provider } = getProviderAndWallet(privateKey);

    const balance = await provider.getBalance(address);
    return ethers.utils.formatEther(balance);
}


// ========== USDC.e相关功能 ==========

/**
 * 获取USDC.e余额
 * @param {string} address - 要查询的地址
 * @param {string} privateKey - 私钥（可选）
 * @returns {Promise<string>} 格式化后的余额（单位：USDC）
 */
export async function getUSDCeBalance(address, privateKey = null) {
    const { wallet } = getProviderAndWallet(privateKey);

    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);

    // 获取decimals（USDC.e是6位小数）
    const decimals = await usdcContract.decimals();

    // 获取余额
    const balance = await usdcContract.balanceOf(address);

    // 格式化余额
    return ethers.utils.formatUnits(balance, decimals);
}



/**
 * 划转POL
 * @param {string} privateKeyFrom - 发送方私钥
 * @param {string} addressTo - 接收方地址
 * @param {string} amount - 金额（POL为单位，如"0.1"）
 * @param {object} options - 可选配置
 * @param {string} options.rpcUrl - RPC节点
 * @param {number} options.nonce - 指定nonce
 * @param {string} options.maxFeePerGas - Max Fee Per Gas (Gwei)
 * @param {string} options.maxPriorityFeePerGas - Max Priority Fee Per Gas (Gwei)
 * @param {number} options.gasLimit - Gas Limit
 * @param {number} options.confirmations - 等待的确认数（默认1）
 * @param {number} options.timeout - 等待超时时间（毫秒，默认120000即2分钟）
 * @returns {Promise<{hash: string, receipt: any, from: string, to: string, value: string}>}
 */
export async function transferPOL(privateKeyFrom, addressTo, amount, options = {}) {
    const {
        rpcUrl = RPC_URL,
        nonce = null,
        maxFeePerGas = null,
        maxPriorityFeePerGas = null,
        gasLimit = null,
        confirmations = 1,
        timeout = 120000, // 默认2分钟超时
    } = options;

    // 验证私钥
    if (!privateKeyFrom || privateKeyFrom.trim() === '') {
        throw new Error('私钥不能为空');
    }

    // 初始化provider和wallet (v5)
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKeyFrom.startsWith('0x') ? privateKeyFrom : '0x' + privateKeyFrom;
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`[发送方地址]: ${wallet.address}`);
    console.log(`[接收方地址]: ${addressTo}`);

    // 检查余额
    const balance = await provider.getBalance(wallet.address);
    const balanceInPOL = ethers.utils.formatEther(balance);
    console.log(`[当前POL余额]: ${balanceInPOL}`);

    // 转换金额
    const amountWei = ethers.utils.parseEther(amount);
    console.log(`[转账金额]: ${amount} POL`);

    // 验证余额是否足够
    if (balance.lt(amountWei)) {
        throw new Error(`余额不足: 当前 ${balanceInPOL} POL, 需要 ${amount} POL`);
    }

    // 获取 nonce
    let currentNonce;
    if (nonce !== null) {
        // 手动指定 nonce，跳过检查
        currentNonce = nonce;
        console.log(`[手动指定Nonce]: ${currentNonce}`);
    } else {
        // 自动获取 nonce，检查 pending
        const latestNonce = await provider.getTransactionCount(wallet.address, "latest");
        const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");
        if (pendingNonce > latestNonce) {
            console.warn(`⚠️ 检测到 ${pendingNonce - latestNonce} 笔 pending 交易，先清理或手动指定 nonce`);
            throw new Error(`有 pending 交易，请手动指定 nonce 参数`);
        }
        currentNonce = latestNonce;
        console.log(`[使用Nonce]: ${currentNonce}`);
    }

    // 获取或设置gas费用
    let finalMaxFeePerGas, finalMaxPriorityFeePerGas;
    if (maxFeePerGas !== null && maxPriorityFeePerGas !== null) {
        finalMaxFeePerGas = ethers.utils.parseUnits(maxFeePerGas, "gwei");
        finalMaxPriorityFeePerGas = ethers.utils.parseUnits(maxPriorityFeePerGas, "gwei");
        console.log(`[手动指定Gas]`);
    } else {
        // 使用 Polygon Gas Station API
        const gasPrice = await getGasPrice();
        finalMaxFeePerGas = gasPrice.maxFeePerGas;
        finalMaxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
    }

    console.log(`[MaxFeePerGas]: ${ethers.utils.formatUnits(finalMaxFeePerGas, "gwei")} Gwei`);
    console.log(`[MaxPriorityFeePerGas]: ${ethers.utils.formatUnits(finalMaxPriorityFeePerGas, "gwei")} Gwei`);

    // 构建交易参数
    const txParams = {
        to: addressTo,
        value: amountWei,
        nonce: currentNonce,
        maxFeePerGas: finalMaxFeePerGas,
        maxPriorityFeePerGas: finalMaxPriorityFeePerGas,
        gasLimit: gasLimit || 21000,
        chainId: CHAIN_ID,
        type: 2, // EIP-1559 transaction
    };

    console.log(`[Gas Limit]: ${txParams.gasLimit}`);
    console.log(`[准备发送交易...]`);

    // 发送交易
    const tx = await wallet.sendTransaction(txParams);
    console.log(`[交易已提交]`);
    console.log(`[交易Hash]: ${tx.hash}`);
    console.log(`[PolygonScan]: https://polygonscan.com/tx/${tx.hash}`);

    // 立即验证交易是否存在
    try {
        const checkTx = await provider.getTransaction(tx.hash);
        if (!checkTx) {
            console.warn('⚠️ 警告: 交易hash在RPC节点中未找到，可能存在问题');
        } else {
            console.log(`✓ 交易已在RPC节点确认`);
        }
    } catch (checkError) {
        console.warn('⚠️ 无法验证交易是否存在:', checkError.message);
    }

    console.log(`[等待交易确认...] (最多等待 ${timeout/1000} 秒)`);

    try {
        // 等待确认，设置超时
        const receipt = await tx.wait(confirmations, timeout);
        console.log(`✓ POL转账成功!`);
        console.log(`[区块号]: ${receipt.blockNumber}`);
        console.log(`[Gas使用]: ${receipt.gasUsed.toString()}`);
        console.log(`[交易状态]: ${receipt.status === 1 ? '成功' : '失败'}`);

        return {
            hash: tx.hash,
            receipt,
            from: wallet.address,
            to: addressTo,
            value: amount,
        };
    } catch (error) {
        if (error.code === 'TIMEOUT') {
            console.error(`✗ POL转账超时 (${timeout}ms)`);
            console.error(`交易可能仍在处理中，请查看: https://polygonscan.com/tx/${tx.hash}`);
            throw new Error(`Transaction timeout after ${timeout}ms. Hash: ${tx.hash}`);
        }
        throw error;
    }
}

/**
 * 划转USDC.e
 * @param {string} privateKeyFrom - 发送方私钥
 * @param {string} addressTo - 接收方地址
 * @param {string} amount - 金额（USDC为单位，如"100.5"）
 * @param {object} options - 可选配置
 * @param {string} options.rpcUrl - RPC节点
 * @param {number} options.nonce - 指定nonce
 * @param {string} options.maxFeePerGas - Max Fee Per Gas (Gwei)
 * @param {string} options.maxPriorityFeePerGas - Max Priority Fee Per Gas (Gwei)
 * @param {number} options.gasLimit - Gas Limit
 * @param {number} options.confirmations - 等待的确认数（默认1）
 * @param {number} options.timeout - 等待超时时间（毫秒，默认120000即2分钟）
 * @returns {Promise<{hash: string, receipt: any, from: string, to: string, value: string}>}
 */
export async function transferUSDC(privateKeyFrom, addressTo, amount, options = {}) {
    const {
        rpcUrl = RPC_URL,
        nonce = null,
        maxFeePerGas = null,
        maxPriorityFeePerGas = null,
        gasLimit = null,
        confirmations = 1,
        timeout = 120000, // 默认2分钟超时
    } = options;

    // 验证私钥
    if (!privateKeyFrom || privateKeyFrom.trim() === '') {
        throw new Error('私钥不能为空');
    }

    // 初始化provider和wallet (v5)
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKeyFrom.startsWith('0x') ? privateKeyFrom : '0x' + privateKeyFrom;
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`[发送方地址]: ${wallet.address}`);
    console.log(`[接收方地址]: ${addressTo}`);

    // 初始化USDC合约
    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);
    const usdcDecimals = await usdcContract.decimals();
    const amountWei = ethers.utils.parseUnits(amount, usdcDecimals);

    // 检查USDC余额
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    const usdcBalanceFormatted = ethers.utils.formatUnits(usdcBalance, usdcDecimals);
    console.log(`[当前USDC余额]: ${usdcBalanceFormatted}`);
    console.log(`[转账金额]: ${amount} USDC`);

    // 验证余额是否足够
    if (usdcBalance.lt(amountWei)) {
        throw new Error(`USDC余额不足: 当前 ${usdcBalanceFormatted} USDC, 需要 ${amount} USDC`);
    }

    // 检查POL余额（用于支付gas）
    const polBalance = await provider.getBalance(wallet.address);
    const polBalanceFormatted = ethers.utils.formatEther(polBalance);
    console.log(`[POL余额(Gas费)]: ${polBalanceFormatted}`);

    if (polBalance.lt(ethers.utils.parseEther("0.001"))) {
        console.warn('⚠️ 警告: POL余额可能不足以支付Gas费');
    }

    // 获取当前nonce
    const currentNonce = nonce !== null ? nonce : await provider.getTransactionCount(wallet.address, "pending");
    console.log(`[使用Nonce]: ${currentNonce}`);

    // 估算Gas Limit
    let finalGasLimit;
    if (gasLimit !== null) {
        finalGasLimit = gasLimit;
    } else {
        try {
            const estimatedGas = await usdcContract.estimateGas.transfer(addressTo, amountWei);
            finalGasLimit = Math.floor(estimatedGas.toNumber() * 1.2); // 增加20% buffer
            console.log(`[估算Gas Limit]: ${estimatedGas.toString()} (使用: ${finalGasLimit})`);
        } catch (error) {
            console.warn('⚠️ Gas估算失败，使用默认值:', error.message);
            finalGasLimit = 100000; // 默认值
        }
    }

    // 获取或设置gas费用
    let finalMaxFeePerGas, finalMaxPriorityFeePerGas;
    if (maxFeePerGas !== null && maxPriorityFeePerGas !== null) {
        finalMaxFeePerGas = ethers.utils.parseUnits(maxFeePerGas, "gwei");
        finalMaxPriorityFeePerGas = ethers.utils.parseUnits(maxPriorityFeePerGas, "gwei");
        console.log(`[手动指定Gas]`);
    } else {
        // 使用 Polygon Gas Station API
        const gasPrice = await getGasPrice();
        finalMaxFeePerGas = gasPrice.maxFeePerGas;
        finalMaxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
    }

    console.log(`[MaxFeePerGas]: ${ethers.utils.formatUnits(finalMaxFeePerGas, "gwei")} Gwei`);
    console.log(`[MaxPriorityFeePerGas]: ${ethers.utils.formatUnits(finalMaxPriorityFeePerGas, "gwei")} Gwei`);
    console.log(`[Gas Limit]: ${finalGasLimit}`);

    // 构建交易参数
    const txParams = {
        gasLimit: finalGasLimit,
        nonce: currentNonce,
        maxFeePerGas: finalMaxFeePerGas,
        maxPriorityFeePerGas: finalMaxPriorityFeePerGas,
        type: 2, // EIP-1559 transaction
    };

    console.log(`[准备发送交易...]`);

    // 发送交易
    const tx = await usdcContract.transfer(addressTo, amountWei, txParams);
    console.log(`[交易已提交]`);
    console.log(`[交易Hash]: ${tx.hash}`);
    console.log(`[PolygonScan]: https://polygonscan.com/tx/${tx.hash}`);

    // 立即验证交易是否存在
    try {
        const checkTx = await provider.getTransaction(tx.hash);
        if (!checkTx) {
            console.warn('⚠️ 警告: 交易hash在RPC节点中未找到，可能存在问题');
        } else {
            console.log(`✓ 交易已在RPC节点确认`);
        }
    } catch (checkError) {
        console.warn('⚠️ 无法验证交易是否存在:', checkError.message);
    }

    console.log(`[等待交易确认...] (最多等待 ${timeout/1000} 秒)`);

    try {
        // 等待确认，设置超时
        const receipt = await tx.wait(confirmations, timeout);
        console.log(`✓ USDC转账成功!`);
        console.log(`[区块号]: ${receipt.blockNumber}`);
        console.log(`[Gas使用]: ${receipt.gasUsed.toString()}`);
        console.log(`[交易状态]: ${receipt.status === 1 ? '成功' : '失败'}`);

        return {
            hash: tx.hash,
            receipt,
            from: wallet.address,
            to: addressTo,
            value: amount,
        };
    } catch (error) {
        if (error.code === 'TIMEOUT') {
            console.error(`✗ USDC转账超时 (${timeout}ms)`);
            console.error(`交易可能仍在处理中，请查看: https://polygonscan.com/tx/${tx.hash}`);
            throw new Error(`Transaction timeout after ${timeout}ms. Hash: ${tx.hash}`);
        }
        throw error;
    }
}

/**
 * 未调通
 * 赎回 Polymarket CTF 合约的仓位
 * @param {string} privateKey - 私钥
 * @param {string} conditionId - 市场ID (marketId)
 * @param {object} options - 可选配置
 * @param {string} options.rpcUrl - RPC节点
 * @param {number} options.nonce - 指定nonce
 * @param {string} options.maxFeePerGas - Max Fee Per Gas (Gwei)
 * @param {string} options.maxPriorityFeePerGas - Max Priority Fee Per Gas (Gwei)
 * @param {number} options.gasLimit - Gas Limit
 * @param {number} options.confirmations - 等待的确认数（默认1）
 * @param {number} options.timeout - 等待超时时间（毫秒，默认120000即2分钟）
 * @returns {Promise<{hash: string, receipt: any, from: string, conditionId: string}>}
 */
export async function redeemPositions(privateKey, conditionId, options = {}) {
    const {
        rpcUrl = RPC_URL,
        nonce = null,
        maxFeePerGas = null,
        maxPriorityFeePerGas = null,
        gasLimit = null,
        confirmations = 1,
        timeout = 120000, // 默认2分钟超时
    } = options;

    // 验证私钥
    if (!privateKey || privateKey.trim() === '') {
        throw new Error('私钥不能为空');
    }

    // 验证 conditionId
    if (!conditionId || conditionId.trim() === '') {
        throw new Error('conditionId (marketId) 不能为空');
    }

    // 初始化provider和wallet (v5)
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`[发送方地址]: ${wallet.address}`);
    console.log(`[ConditionId (MarketId)]: ${conditionId}`);

    // 初始化CTF合约
    const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

    // 固定参数
    const collateralToken = USDC_E_ADDRESS;
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const indexSets = [1, 2];

    console.log(`[CollateralToken]: ${collateralToken}`);
    console.log(`[ParentCollectionId]: ${parentCollectionId}`);
    console.log(`[IndexSets]: [${indexSets.join(', ')}]`);

    // 检查POL余额（用于支付gas）
    const polBalance = await provider.getBalance(wallet.address);
    const polBalanceFormatted = ethers.utils.formatEther(polBalance);
    console.log(`[POL余额(Gas费)]: ${polBalanceFormatted}`);

    if (polBalance.lt(ethers.utils.parseEther("0.001"))) {
        console.warn('⚠️ 警告: POL余额可能不足以支付Gas费');
    }

    // 获取当前nonce
    let currentNonce;
    if (nonce !== null) {
        currentNonce = nonce;
        console.log(`[手动指定Nonce]: ${currentNonce}`);
    } else {
        const latestNonce = await provider.getTransactionCount(wallet.address, "latest");
        const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");
        if (pendingNonce > latestNonce) {
            console.warn(`⚠️ 检测到 ${pendingNonce - latestNonce} 笔 pending 交易，先清理或手动指定 nonce`);
            throw new Error(`有 pending 交易，请手动指定 nonce 参数`);
        }
        currentNonce = latestNonce;
        console.log(`[使用Nonce]: ${currentNonce}`);
    }

    // 估算Gas Limit
    let finalGasLimit;
    if (gasLimit !== null) {
        finalGasLimit = gasLimit;
    } else {
        try {
            const estimatedGas = await ctfContract.estimateGas.redeemPositions(
                collateralToken,
                parentCollectionId,
                conditionId,
                indexSets
            );
            finalGasLimit = Math.floor(estimatedGas.toNumber() * 1.2); // 增加20% buffer
            console.log(`[估算Gas Limit]: ${estimatedGas.toString()} (使用: ${finalGasLimit})`);
        } catch (error) {
            console.warn('⚠️ Gas估算失败，使用默认值:', error.message);
            finalGasLimit = 200000; // 默认值
        }
    }

    // 获取或设置gas费用
    let finalMaxFeePerGas, finalMaxPriorityFeePerGas;
    if (maxFeePerGas !== null && maxPriorityFeePerGas !== null) {
        finalMaxFeePerGas = ethers.utils.parseUnits(maxFeePerGas, "gwei");
        finalMaxPriorityFeePerGas = ethers.utils.parseUnits(maxPriorityFeePerGas, "gwei");
        console.log(`[手动指定Gas]`);
    } else {
        // 使用 Polygon Gas Station API
        const gasPrice = await getGasPrice();
        finalMaxFeePerGas = gasPrice.maxFeePerGas;
        finalMaxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
    }

    console.log(`[MaxFeePerGas]: ${ethers.utils.formatUnits(finalMaxFeePerGas, "gwei")} Gwei`);
    console.log(`[MaxPriorityFeePerGas]: ${ethers.utils.formatUnits(finalMaxPriorityFeePerGas, "gwei")} Gwei`);
    console.log(`[Gas Limit]: ${finalGasLimit}`);

    // 构建交易参数
    const txParams = {
        gasLimit: finalGasLimit,
        nonce: currentNonce,
        maxFeePerGas: finalMaxFeePerGas,
        maxPriorityFeePerGas: finalMaxPriorityFeePerGas,
        type: 2, // EIP-1559 transaction
    };

    console.log(`[准备发送交易...]`);

    // 发送交易
    const tx = await ctfContract.redeemPositions(
        collateralToken,
        parentCollectionId,
        conditionId,
        indexSets,
        txParams
    );
    console.log(`[交易已提交]`);
    console.log(`[交易Hash]: ${tx.hash}`);
    console.log(`[PolygonScan]: https://polygonscan.com/tx/${tx.hash}`);

    // 立即验证交易是否存在
    try {
        const checkTx = await provider.getTransaction(tx.hash);
        if (!checkTx) {
            console.warn('⚠️ 警告: 交易hash在RPC节点中未找到，可能存在问题');
        } else {
            console.log(`✓ 交易已在RPC节点确认`);
        }
    } catch (checkError) {
        console.warn('⚠️ 无法验证交易是否存在:', checkError.message);
    }

    console.log(`[等待交易确认...] (最多等待 ${timeout/1000} 秒)`);

    try {
        // 等待确认，设置超时
        const receipt = await tx.wait(confirmations, timeout);
        console.log(`✓ CTF仓位赎回成功!`);
        console.log(`[区块号]: ${receipt.blockNumber}`);
        console.log(`[Gas使用]: ${receipt.gasUsed.toString()}`);
        console.log(`[交易状态]: ${receipt.status === 1 ? '成功' : '失败'}`);

        return {
            hash: tx.hash,
            receipt,
            from: wallet.address,
            conditionId: conditionId,
        };
    } catch (error) {
        if (error.code === 'TIMEOUT') {
            console.error(`✗ CTF仓位赎回超时 (${timeout}ms)`);
            console.error(`交易可能仍在处理中，请查看: https://polygonscan.com/tx/${tx.hash}`);
            throw new Error(`Transaction timeout after ${timeout}ms. Hash: ${tx.hash}`);
        }
        throw error;
    }
}

/**
 * 查询余额
 * @param {string} address - 钱包地址
 * @param {string} rpcUrl - RPC节点
 * @returns {Promise<{pol: string, usdc: string}>}
 */
export async function getBalances(address, rpcUrl = RPC_URL) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);

    // 查询POL余额
    const polBalance = await provider.getBalance(address);
    const polAmount = ethers.utils.formatEther(polBalance);

    // 查询USDC余额
    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
    const usdcDecimals = await usdcContract.decimals();
    const usdcBalance = await usdcContract.balanceOf(address);
    const usdcAmount = ethers.utils.formatUnits(usdcBalance, usdcDecimals);

    return {
        pol: polAmount,
        usdc: usdcAmount,
    };
}

/**
 * 获取当前nonce
 * @param {string} privateKey - 私钥
 * @param {string} rpcUrl - RPC节点
 * @returns {Promise<{current: number, pending: number}>}
 */
export async function getNonce(privateKey, rpcUrl = RPC_URL) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    const currentNonce = await provider.getTransactionCount(wallet.address, "latest");
    const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");

    return {
        current: currentNonce,
        pending: pendingNonce,
    };
}

/**
 * 获取链上已确认的最新nonce
 * @param {string} privateKey - 私钥
 * @param {string} rpcUrl - RPC节点
 * @returns {Promise<number>} 已确认的nonce
 */
export async function getConfirmedNonce(privateKey, rpcUrl = RPC_URL) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    // "latest" 返回已经确认上链的交易数量
    const confirmedNonce = await provider.getTransactionCount(wallet.address, "latest");

    return confirmedNonce;
}

/**
 * 获取最近使用的nonce（包括pending交易）
 * @param {string} privateKey - 私钥
 * @param {string} rpcUrl - RPC节点
 * @returns {Promise<number>} pending状态的nonce（下一个可用nonce）
 */
export async function getLatestUsedNonce(privateKey, rpcUrl = RPC_URL) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    // "pending" 返回包括待处理交易在内的nonce（下一个应该使用的nonce）
    const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");

    return pendingNonce;
}

/**
 * 检查是否有pending交易
 * @param {string} privateKey - 私钥
 * @param {string} rpcUrl - RPC节点
 * @returns {Promise<{hasPending: boolean, confirmedNonce: number, pendingNonce: number, stuckCount: number}>}
 */
export async function checkPendingTransactions(privateKey, rpcUrl = RPC_URL) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    const confirmedNonce = await provider.getTransactionCount(wallet.address, "latest");
    const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");

    const stuckCount = pendingNonce - confirmedNonce;
    const hasPending = stuckCount > 0;

    console.log(`\n========== 交易状态检查 ==========`);
    console.log(`钱包地址: ${wallet.address}`);
    console.log(`已确认 nonce: ${confirmedNonce}`);
    console.log(`待处理 nonce: ${pendingNonce}`);
    console.log(`卡住的交易数: ${stuckCount}`);

    if (hasPending) {
        console.log(`⚠️ 有 ${stuckCount} 笔交易在 pending 状态`);
        console.log(`卡住的 nonce 范围: ${confirmedNonce} - ${pendingNonce - 1}`);
    } else {
        console.log(`✓ 没有 pending 交易`);
    }
    console.log(`==================================\n`);

    return {
        hasPending,
        confirmedNonce,
        pendingNonce,
        stuckCount,
    };
}

/**
 * 加速或替换卡住的交易（发送一个相同nonce但更高gas的交易）
 * @param {string} privateKey - 私钥
 * @param {number} stuckNonce - 卡住的nonce
 * @param {object} options - 可选配置
 * @param {string} options.rpcUrl - RPC节点
 * @param {number} options.gasPriceMultiplier - Gas价格倍数（默认1.5倍）
 * @returns {Promise<{hash: string, receipt: any}>}
 */
export async function speedUpTransaction(privateKey, stuckNonce, options = {}) {
    const {
        rpcUrl = RPC_URL,
        gasPriceMultiplier = 1.5,
    } = options;

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, CHAIN_ID);
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk, provider);

    console.log(`\n========== 加速交易 ==========`);
    console.log(`钱包地址: ${wallet.address}`);
    console.log(`加速 nonce: ${stuckNonce}`);

    // 获取当前推荐的 gas 价格
    const gasPrice = await getGasPrice();

    // 应用倍数
    const boostedMaxFeePerGas = gasPrice.maxFeePerGas.mul(Math.floor(gasPriceMultiplier * 100)).div(100);
    const boostedMaxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas.mul(Math.floor(gasPriceMultiplier * 100)).div(100);

    console.log(`原始 MaxFeePerGas: ${ethers.utils.formatUnits(gasPrice.maxFeePerGas, "gwei")} Gwei`);
    console.log(`加速 MaxFeePerGas: ${ethers.utils.formatUnits(boostedMaxFeePerGas, "gwei")} Gwei (${gasPriceMultiplier}x)`);
    console.log(`加速 MaxPriorityFeePerGas: ${ethers.utils.formatUnits(boostedMaxPriorityFeePerGas, "gwei")} Gwei (${gasPriceMultiplier}x)`);

    // 发送一个空交易到自己地址，使用更高的 gas 来替换卡住的交易
    const txParams = {
        to: wallet.address,
        value: 0,
        nonce: stuckNonce,
        maxFeePerGas: boostedMaxFeePerGas,
        maxPriorityFeePerGas: boostedMaxPriorityFeePerGas,
        gasLimit: 21000,
        chainId: CHAIN_ID,
        type: 2,
    };

    console.log(`发送替换交易（转账 0 POL 到自己地址）...`);
    const tx = await wallet.sendTransaction(txParams);
    console.log(`替换交易已提交: ${tx.hash}`);
    console.log(`PolygonScan: https://polygonscan.com/tx/${tx.hash}`);
    console.log(`==================================\n`);

    // 等待确认
    const receipt = await tx.wait(1, 120000);
    console.log(`✓ 交易已确认! 区块: ${receipt.blockNumber}`);

    return { hash: tx.hash, receipt };
}

// ========== 默认导出 ==========
export default {
    getPOLBalance,
    getUSDCeBalance,
    transferPOL,
    transferUSDC,
    redeemPositions,
    getBalances,
    getNonce,
    getConfirmedNonce,
    getLatestUsedNonce,
    checkPendingTransactions,
    speedUpTransaction,
    getGasPrice,
};
