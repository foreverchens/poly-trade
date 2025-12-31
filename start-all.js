#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEB_SERVER = join(__dirname, "src/icu/poly/web-server.js");
// const TAIL_BOT = join(__dirname, "src/icu/poly/tail-bot-start-up.js");
const LOGS_DIR = join(__dirname, "logs");
const PID_FILE = join(__dirname, "logs", "start-all.pids");

// 确保 logs 目录存在（用于保存 PID 文件）
if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
}

const pids = [];

function startProcess(name, script) {
    console.log(chalk.cyan(`[启动] ${name}...`));

    const proc = spawn("node", [script], {
        stdio: "ignore",
        cwd: __dirname,
        detached: true,
    });

    proc.on("error", (err) => {
        console.error(chalk.red(`[错误] ${name} 启动失败:`), err);
        process.exit(1);
    });

    // 保存 PID
    pids.push({
        name,
        pid: proc.pid,
        script,
    });

    // 让子进程独立运行
    proc.unref();

    return proc;
}

// 保存 PID 到文件
function savePids() {
    const pidData = pids.map((p) => `${p.name}:${p.pid}:${p.script}`).join("\n");
    writeFileSync(PID_FILE, pidData, "utf8");
}

// 启动两个服务
console.log(chalk.blue("=".repeat(50)));
console.log(chalk.blue("后台启动 Poly 服务"));
console.log(chalk.blue("=".repeat(50)));

startProcess("Web Server", WEB_SERVER);
// startProcess("Tail Bot", TAIL_BOT);

// 保存 PID
savePids();

console.log(chalk.green("\n[就绪] 所有服务已在后台启动"));
console.log(chalk.yellow("\n进程信息:"));
pids.forEach((p) => {
    console.log(chalk.cyan(`  ${p.name}: PID ${p.pid}`));
});
console.log(chalk.gray(`\n停止服务: kill ${pids.map((p) => p.pid).join(" ")}`));
console.log(chalk.gray(`或使用: npm run stop:all\n`));

// 父进程立即退出，让子进程在后台运行
process.exit(0);
