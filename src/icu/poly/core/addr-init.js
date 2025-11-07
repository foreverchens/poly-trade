// Requires: Node 18+, ethers v6
// npm i ethers

import { ethers } from "ethers";

// ========== 环境变量 ==========
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";

//导出的私钥在v6版本下需要加上0x前缀
const PRIVATE_KEY = '0x'+process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY || null; // 可选，不填自动从私钥推导
const CHAIN_ID = 137; // Polygon

if (!PRIVATE_KEY) {
    console.error("请设置 PRIVATE_KEY 环境变量");
    process.exit(1);
}

// ========== 目标合约与地址（来自 Gist） ==========
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC.e 非原生USDC!!!!
const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // CTF(ERC1155)

// 三个需要授权/批准的目标（与 Gist 一致）
const TARGETS = [
    { name: "CTF Exchange",        addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
    { name: "Neg Risk CTF Exchange", addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
    { name: "Neg Risk Adapter",      addr: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" },
];

// ========== 轻量 ABI ==========
const ERC20_ABI = [
    "function approve(address spender, uint256 value) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const owner = PUBLIC_KEY || wallet.address;

    console.log(`使用地址: ${owner}`);
    const polBal = await provider.getBalance(owner);
    console.log(`POL 余额: ${ethers.formatEther(polBal)} POL`);

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctf  = new ethers.Contract(CTF_ADDRESS,  ERC1155_ABI, wallet);

    // 打印 USDC 小数位，方便校验
    const usdcDecimals = await usdc.decimals().catch(() => 6);
    console.log(`USDC decimals = ${usdcDecimals}`);

    for (const t of TARGETS) {
        console.log(`\n=== 处理目标：${t.name} (${t.addr}) ===`);

        // 1) USDC 无限额授权
        const curAllowance = await usdc.allowance(owner, t.addr);
        console.log(`当前 USDC allowance: ${curAllowance}`);

        if (curAllowance < ethers.MaxUint256 / 2n) {
            console.log("发送 USDC approve(MaxUint256) 交易...");
            const tx = await usdc.approve(t.addr, ethers.MaxUint256);
            console.log(`提交 tx: ${tx.hash}`);
            const rcpt = await tx.wait();
            console.log(`USDC approve 成功，区块: ${rcpt.blockNumber}`);
        } else {
            console.log("已是大额度授权，跳过 USDC approve。");
        }

        // 2) ERC1155 setApprovalForAll(true)
        const approved = await ctf.isApprovedForAll(owner, t.addr);
        console.log(`当前 ERC1155 isApprovedForAll: ${approved}`);

        if (!approved) {
            console.log("发送 setApprovalForAll(true) 交易...");
            const tx2 = await ctf.setApprovalForAll(t.addr, true);
            console.log(`提交 tx: ${tx2.hash}`);
            const rcpt2 = await tx2.wait();
            console.log(`setApprovalForAll 成功，区块: ${rcpt2.blockNumber}`);
        } else {
            console.log("已是 ERC1155 批准状态，跳过 setApprovalForAll。");
        }
    }

    console.log("\n全部处理完成。");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
