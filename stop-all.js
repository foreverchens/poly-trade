#!/usr/bin/env node

import { readFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PID_FILE = join(__dirname, "logs", "start-all.pids");

async function stopAll() {
    if (!existsSync(PID_FILE)) {
        console.log(chalk.yellow("[提示] 未找到 PID 文件，尝试通过进程名停止..."));
        try {
            execSync(`pkill -f "node.*web-server.js"`, { stdio: "ignore" });
            execSync(`pkill -f "node.*tail-bot-start-up.js"`, { stdio: "ignore" });
            console.log(chalk.green("[完成] 已尝试停止所有服务"));
        } catch (err) {
            console.log(chalk.yellow("[提示] 未找到运行中的服务"));
        }
        return;
    }

    const pidData = readFileSync(PID_FILE, "utf8");
    const lines = pidData.trim().split("\n").filter((line) => line.trim());

    console.log(chalk.blue("=".repeat(50)));
    console.log(chalk.blue("停止 Poly 服务"));
    console.log(chalk.blue("=".repeat(50)));

    let stoppedCount = 0;
    for (const line of lines) {
        const [name, pidStr] = line.split(":");
        const pid = Number.parseInt(pidStr, 10);

        if (!Number.isInteger(pid)) {
            console.log(chalk.yellow(`[跳过] ${name}: 无效的 PID`));
            continue;
        }

        try {
            // 检查进程是否存在
            process.kill(pid, 0);
            // 进程存在，尝试停止
            process.kill(pid, "SIGTERM");
            console.log(chalk.green(`[停止] ${name} (PID: ${pid})`));
            stoppedCount++;
        } catch (err) {
            if (err.code === "ESRCH") {
                console.log(chalk.yellow(`[跳过] ${name} (PID: ${pid}): 进程不存在`));
            } else {
                console.log(chalk.red(`[错误] ${name} (PID: ${pid}): ${err.message}`));
            }
        }
    }

    // 等待一下，然后强制杀死
    if (stoppedCount > 0) {
        console.log(chalk.gray("\n等待进程退出..."));
        await new Promise((resolve) => setTimeout(resolve, 2000));

        for (const line of lines) {
            const [, pidStr] = line.split(":");
            const pid = Number.parseInt(pidStr, 10);
            if (Number.isInteger(pid)) {
                try {
                    process.kill(pid, 0);
                    process.kill(pid, "SIGKILL");
                    console.log(chalk.yellow(`[强制停止] PID: ${pid}`));
                } catch (err) {
                    // 进程已不存在，忽略
                }
            }
        }
    }

    // 删除 PID 文件
    if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
    }
    console.log(chalk.green("\n[完成] 所有服务已停止"));
}

stopAll();
