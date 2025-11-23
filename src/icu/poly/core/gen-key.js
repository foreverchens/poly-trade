import { ethers } from "ethers";
import { fileURLToPath } from 'url';

/**
 * 从助记词生成私钥和地址 (Based on Polygon/ETH Standard)
 * Works with ethers v5
 *
 * @param {string} mnemonic - 助记词 (12 or 24 words)
 * @param {number} [index=0] - 推导路径索引 (默认0)。基于 BIP-32 规范，非硬化推导的有效范围是 0 到 2,147,483,647 (2^31 - 1)。
 * @returns {{ address: string, privateKey: string, path: string }}
 */
export function generateAccountFromMnemonic(mnemonic, index = 0) {
    if (!mnemonic) {
        throw new Error("Mnemonic is required");
    }

    try {
        // Ethers v5 implementation
        // 标准路径 m/44'/60'/0'/0/index
        // 默认 index = 0
        const path = `m/44'/60'/0'/0/${index}`;
        const wallet = ethers.Wallet.fromMnemonic(mnemonic, path);

        return {
            address: wallet.address,
            privateKey: wallet.privateKey,
            path: path
        };
    } catch (error) {
        // Fallback logic if using ethers v6 or other issues,
        // but since package.json says v5, we stick to v5 API.
        console.error(`Failed to generate wallet from mnemonic at index ${index}:`, error);
        throw error;
    }
}

// === 独立运行测试实例 ===
// Usage: node src/icu/poly/core/gen-key.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // ===在此处填写您的助记词===
    // 如果留空，脚本将自动生成随机助记词用于演示
    const mnemonic = "lava useless vault bar day hunt around lion general train traffic rich";

    // ===生成数量===
    const ACCOUNT_COUNT = 5;
    console.log("--- Polygon/ETH Key Generator ---");

    console.log(`\n准备生成前 ${ACCOUNT_COUNT} 组地址/私钥...\n`);

    try {
        for (let i = 0; i < ACCOUNT_COUNT; i++) {
            const account = generateAccountFromMnemonic(mnemonic, i);
            console.log(`[Account #${i}]`);
            console.log(`  Path:        ${account.path}`);
            console.log(`  Address:     ${account.address}`);
            console.log(`  Private Key: ${account.privateKey}`);
            console.log("-".repeat(50));
        }
        console.log("\nNote: Valid for Polygon (Matic), Ethereum, and other EVM chains.");
    } catch (error) {
        console.error("Error:", error.message);
    }
}
