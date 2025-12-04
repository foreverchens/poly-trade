function formatUsdcBalance(value) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return `${value}`;
    }
    return numeric >= 1 ? numeric.toFixed(2) : numeric.toFixed(4);
}

const columnDefs = [
    { key: "task.name", label: "任务名称", type: "text", width: 180 },
    {
        key: "task.slug",
        label: "Slug",
        type: "text",
        width: 220,
        editable: (row) => row.__isNew === true,
    },
    { key: "task.symbol", label: "Symbol", type: "text", width: 80 },
    { key: "task.pkIdx", label: "pkIdx", type: "number", integer: true, width: 70 },
    { key: "task.active", label: "Active", type: "boolean", width: 70 },
    { key: "task.test", label: "Test", type: "boolean", width: 70 },
    { key: "schedule.cronExpression", label: "Cron 表达式", type: "text", width: 220 },
    { key: "schedule.cronTimeZone", label: "时区", type: "text", width: 130 },
    {
        key: "schedule.tickIntervalSeconds",
        label: "Tick (s)",
        type: "number",
        integer: true,
        width: 90,
    },
    { key: "position.positionSizeUsdc", label: "建仓额", type: "number", width: 90 },
    { key: "position.extraSizeUsdc", label: "补仓额", type: "number", width: 90 },
    { key: "position.allowExtraEntryAtCeiling", label: "Allow Extra", type: "boolean", width: 110 },
    {
        key: "riskControl.price.triggerPriceGt",
        label: "触发价 >=",
        type: "number",
        step: "0.0001",
        width: 110,
    },
    {
        key: "riskControl.price.takeProfitPrice",
        label: "止盈价",
        type: "number",
        step: "0.0001",
        width: 90,
    },
    {
        key: "riskControl.time.maxMinutesToEnd",
        label: "最大剩余分钟",
        type: "number",
        integer: true,
        width: 120,
    },
    {
        key: "riskControl.time.monitorModeMinuteThreshold",
        label: "监控阈值",
        type: "number",
        integer: true,
        width: 110,
    },
    { key: "riskControl.statistics.zMin", label: "zMin", type: "number", step: "0.1", width: 80 },
    {
        key: "riskControl.statistics.ampMin",
        label: "ampMin",
        type: "number",
        step: "0.0001",
        width: 90,
    },
    {
        key: "riskControl.statistics.highVolatilityZThreshold",
        label: "高波动 z",
        type: "number",
        step: "0.1",
        width: 110,
    },
    {
        key: "riskControl.liquidity.sufficientThreshold",
        label: "流动性阈值",
        type: "number",
        width: 120,
    },
    {
        key: "riskControl.spikeProtection.count",
        label: "Spike Count",
        type: "number",
        integer: true,
        width: 110,
    },
    { key: "extra", label: "Extra(JSON)", type: "textarea", width: 220 },
    {
        key: "createTime",
        label: "创建时间",
        type: "readonly",
        width: 150,
        editable: false,
        formatter: (value) => formatDateTime(value),
    },
    { key: "__actions", label: "操作", type: "actions", editable: false, width: 150 },
].map((col) => ({
    ...col,
    path: col.key && !col.key.startsWith("__") ? col.key.split(".") : null,
}));

const headerRow = document.getElementById("table-header-row");
columnDefs.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    if (column.width) {
        th.style.minWidth = `${column.width}px`;
    }
    headerRow.appendChild(th);
});

const state = {
    items: [],
    editing: null,
    tempId: 0,
    loading: false,
};

const tableBody = document.getElementById("task-table-body");
const messageEl = document.getElementById("message");
const refreshBtn = document.getElementById("btn-refresh");
const createBtn = document.getElementById("btn-create");
const totalBalanceEl = document.getElementById("total-balance");
const accountsTableBody = document.getElementById("accounts-table-body");
const refreshAccountsBtn = document.getElementById("btn-refresh-accounts");

async function fetchTasks() {
    if (state.loading) return;
    state.loading = true;
    setTableLoading();
    try {
        const response = await fetch("/api/convergence-tasks");
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "加载配置失败");
        }
        const payload = await response.json();
        state.items = (payload.items || []).map((item) => ({
            ...item,
            __isNew: false,
            __dirty: false,
        }));
        showMessage(`已加载 ${state.items.length} 条配置`);
        renderTable();
        updateTotalBalance();
    } catch (err) {
        showMessage(err.message, "error");
        state.items = [];
        renderTable();
    } finally {
        state.loading = false;
    }
}

function setTableLoading() {
    tableBody.innerHTML = `<tr><td class="empty" colspan="${columnDefs.length}">加载中...</td></tr>`;
}

function renderTable() {
    tableBody.innerHTML = "";
    if (!state.items.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "empty";
        cell.colSpan = columnDefs.length;
        cell.textContent = "暂无任务配置";
        row.appendChild(cell);
        tableBody.appendChild(row);
        return;
    }

    state.items.forEach((item, rowIndex) => {
        const tr = document.createElement("tr");
        if (item.__isNew) {
            tr.classList.add("is-new");
        }

        columnDefs.forEach((column) => {
            const td = document.createElement("td");
            td.dataset.rowIndex = rowIndex;
            td.dataset.columnKey = column.key;
            if (column.width) {
                td.style.minWidth = `${column.width}px`;
            }

            if (column.key === "__actions") {
                td.classList.add("actions");
                td.appendChild(createActionsCell(rowIndex, item));
                tr.appendChild(td);
                return;
            }

            const isEditable = canEditColumn(column, item);
            if (isEditable) {
                td.classList.add("editable");
            }

            if (
                state.editing &&
                state.editing.rowIndex === rowIndex &&
                state.editing.columnKey === column.key
            ) {
                td.classList.add("editing");
                renderEditor(td, column, item, rowIndex);
            } else {
                const rawValue = getValueByPath(item, column.path);
                const text = column.formatter
                    ? column.formatter(rawValue, item)
                    : formatDisplayValue(rawValue, column);
                td.textContent = text;
            }
            tr.appendChild(td);
        });

        tableBody.appendChild(tr);
    });
}

function createActionsCell(rowIndex, item) {
    const fragment = document.createDocumentFragment();
    if (item.__isNew) {
        const saveBtn = document.createElement("button");
        saveBtn.textContent = "保存";
        saveBtn.dataset.action = "save";
        saveBtn.dataset.rowIndex = rowIndex;
        saveBtn.disabled = !item.__dirty;
        fragment.appendChild(saveBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.dataset.action = "cancel-new";
        cancelBtn.dataset.rowIndex = rowIndex;
        fragment.appendChild(cancelBtn);
    } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "删除";
        deleteBtn.className = "danger";
        deleteBtn.dataset.action = "delete";
        deleteBtn.dataset.rowIndex = rowIndex;
        fragment.appendChild(deleteBtn);
    }
    return fragment;
}

function canEditColumn(column, row) {
    if (!column.path) return false;
    if (column.type === "readonly") return false;
    if (typeof column.editable === "function") {
        return column.editable(row);
    }
    if (column.editable === false) return false;
    if (!row.__isNew && column.key === "task.slug") {
        return false;
    }
    return true;
}

function renderEditor(td, column, row, rowIndex) {
    const currentValue = getValueByPath(row, column.path);
    let editor;
    if (column.type === "textarea") {
        editor = document.createElement("textarea");
        editor.value = currentValue ?? "";
    } else if (column.type === "boolean") {
        editor = document.createElement("select");
        ["true", "false"].forEach((optionValue) => {
            const option = document.createElement("option");
            option.value = optionValue;
            option.textContent = optionValue;
            if ((currentValue ?? false).toString() === optionValue) {
                option.selected = true;
            }
            editor.appendChild(option);
        });
    } else {
        editor = document.createElement("input");
        editor.type = column.type === "number" ? "number" : "text";
        if (column.step) {
            editor.step = column.step;
        }
        if (column.integer) {
            editor.step = "1";
        }
        editor.value = currentValue ?? "";
    }

    editor.dataset.rowIndex = rowIndex;
    editor.dataset.columnKey = column.key;
    editor.addEventListener("blur", () => commitEdit(editor));
    editor.addEventListener("keydown", (event) => handleEditorKeydown(event, editor));
    td.innerHTML = "";
    td.appendChild(editor);
    setTimeout(() => editor.focus(), 0);
}

function handleEditorKeydown(event, editor) {
    if (event.key === "Enter" && !(editor.tagName === "TEXTAREA" && event.shiftKey)) {
        event.preventDefault();
        commitEdit(editor);
    }
    if (event.key === "Escape") {
        event.preventDefault();
        state.editing = null;
        renderTable();
    }
}

async function commitEdit(editor) {
    const rowIndex = Number(editor.dataset.rowIndex);
    const columnKey = editor.dataset.columnKey;
    const column = columnDefs.find((col) => col.key === columnKey);
    if (!column) return;

    const row = state.items[rowIndex];
    if (!row) return;

    let newValue;
    try {
        newValue = parseEditorValue(editor, column);
    } catch (err) {
        showMessage(err.message, "error");
        editor.focus();
        return;
    }

    const oldValue = getValueByPath(row, column.path);
    if (valuesEqual(newValue, oldValue)) {
        state.editing = null;
        renderTable();
        return;
    }

    setValueByPath(row, column.path, newValue);
    state.editing = null;
    renderTable();

    if (row.__isNew) {
        row.__dirty = true;
        showMessage("新任务已修改，请点击操作列的保存按钮。");
        renderTable();
    } else {
        try {
            await persistRow(rowIndex, `${column.label}`);
        } catch (err) {
            showMessage(err.message, "error");
            await fetchTasks();
        }
    }
}

function parseEditorValue(editor, column) {
    const value = editor.value;
    if (column.type === "number") {
        if (value === "") {
            throw new Error(`${column.label} 不能为空`);
        }
        const num = Number(value);
        if (!Number.isFinite(num)) {
            throw new Error(`${column.label} 必须是数字`);
        }
        if (column.integer && !Number.isInteger(num)) {
            throw new Error(`${column.label} 必须是整数`);
        }
        return num;
    }
    if (column.type === "boolean") {
        return value === "true";
    }
    return value;
}

function formatDisplayValue(value, column) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }
    if (column.type === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number") {
        return column.integer ? `${Math.trunc(value)}` : `${value}`;
    }
    return `${value}`;
}

function valuesEqual(a, b) {
    if (typeof a === "number" && typeof b === "number") {
        return Number.isNaN(a) && Number.isNaN(b) ? true : a === b;
    }
    return a === b;
}

function getValueByPath(source, path) {
    if (!path) return undefined;
    return path.reduce(
        (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
        source,
    );
}

function setValueByPath(target, path, value) {
    if (!path || !path.length) return;
    let current = target;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (current[key] === undefined || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[path[path.length - 1]] = value;
}

async function persistRow(rowIndex, hintLabel = "") {
    const row = state.items[rowIndex];
    if (!row) return;
    if (!row.task?.slug) {
        throw new Error("task.slug 不能为空");
    }
    const payload = buildPayload(row);
    const method = row.__isNew ? "POST" : "PUT";
    const url = row.__isNew
        ? "/api/convergence-tasks"
        : `/api/convergence-tasks/${encodeURIComponent(row.task.slug)}`;
    const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "保存失败");
    }
    const saved = await response.json();
    state.items[rowIndex] = {
        ...saved,
        __isNew: false,
        __dirty: false,
    };
    renderTable();
    updateTotalBalance();
    showMessage(hintLabel ? `${hintLabel} 已保存` : "配置已保存", "success");
}

function buildPayload(row) {
    return {
        task: {
            name: row.task?.name ?? "",
            slug: row.task?.slug ?? "",
            symbol: row.task?.symbol ?? "",
            pkIdx: row.task?.pkIdx ?? 0,
            active: Boolean(row.task?.active),
            test: Boolean(row.task?.test),
        },
        schedule: {
            cronExpression: row.schedule?.cronExpression ?? "",
            cronTimeZone: row.schedule?.cronTimeZone ?? "",
            tickIntervalSeconds: row.schedule?.tickIntervalSeconds ?? 0,
        },
        position: {
            positionSizeUsdc: row.position?.positionSizeUsdc ?? 0,
            extraSizeUsdc: row.position?.extraSizeUsdc ?? 0,
            allowExtraEntryAtCeiling: Boolean(row.position?.allowExtraEntryAtCeiling),
        },
        riskControl: {
            price: {
                triggerPriceGt: row.riskControl?.price?.triggerPriceGt ?? 0,
                takeProfitPrice: row.riskControl?.price?.takeProfitPrice ?? 0,
            },
            time: {
                maxMinutesToEnd: row.riskControl?.time?.maxMinutesToEnd ?? 0,
                monitorModeMinuteThreshold: row.riskControl?.time?.monitorModeMinuteThreshold ?? 0,
            },
            statistics: {
                zMin: row.riskControl?.statistics?.zMin ?? 0,
                ampMin: row.riskControl?.statistics?.ampMin ?? 0,
                highVolatilityZThreshold:
                    row.riskControl?.statistics?.highVolatilityZThreshold ?? 0,
            },
            liquidity: {
                sufficientThreshold: row.riskControl?.liquidity?.sufficientThreshold ?? 0,
            },
            spikeProtection: {
                count: row.riskControl?.spikeProtection?.count ?? 0,
            },
        },
        extra: row.extra ?? "",
    };
}

function createEmptyTask() {
    return {
        task: {
            name: "",
            slug: "",
            symbol: "",
            pkIdx: 0,
            active: true,
            test: false,
        },
        schedule: {
            cronExpression: "",
            cronTimeZone: "America/New_York",
            tickIntervalSeconds: 60,
        },
        position: {
            positionSizeUsdc: 0,
            extraSizeUsdc: 0,
            allowExtraEntryAtCeiling: true,
        },
        riskControl: {
            price: {
                triggerPriceGt: 0,
                takeProfitPrice: 0,
            },
            time: {
                maxMinutesToEnd: 0,
                monitorModeMinuteThreshold: 0,
            },
            statistics: {
                zMin: 0,
                ampMin: 0,
                highVolatilityZThreshold: 0,
            },
            liquidity: {
                sufficientThreshold: 0,
            },
            spikeProtection: {
                count: 0,
            },
        },
        extra: "",
        createTime: null,
        __isNew: true,
        __dirty: false,
        __tempId: `temp-${Date.now()}-${state.tempId++}`,
    };
}

function showMessage(text, type = "") {
    messageEl.textContent = text || "";
    messageEl.className = `message ${type}`;
}

function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour12: false })}`;
}

function updateTotalBalance() {
    const uniqueAccounts = new Map();
    state.items.forEach((item) => {
        const account = item.account;
        if (account?.address && account.usdcBalance !== null && account.usdcBalance !== undefined) {
            if (!uniqueAccounts.has(account.address)) {
                uniqueAccounts.set(account.address, account.usdcBalance);
            }
        }
    });
    const total = Array.from(uniqueAccounts.values()).reduce((sum, balance) => {
        const num = Number(balance);
        return sum + (Number.isFinite(num) ? num : 0);
    }, 0);
    totalBalanceEl.textContent = formatUsdcBalance(total);
}

tableBody.addEventListener("dblclick", (event) => {
    const td = event.target.closest("td");
    if (!td) return;
    const rowIndex = Number(td.dataset.rowIndex);
    const columnKey = td.dataset.columnKey;
    const column = columnDefs.find((col) => col.key === columnKey);
    if (!column) return;
    const row = state.items[rowIndex];
    if (!row) return;
    if (!canEditColumn(column, row)) return;
    state.editing = { rowIndex, columnKey };
    renderTable();
});

tableBody.addEventListener("click", (event) => {
    const actionBtn = event.target.closest("button[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    const rowIndex = Number(actionBtn.dataset.rowIndex);
    const row = state.items[rowIndex];
    if (!row) return;

    if (action === "delete") {
        handleDelete(rowIndex);
    } else if (action === "save") {
        persistRow(rowIndex).catch((err) => showMessage(err.message, "error"));
    } else if (action === "cancel-new") {
        state.items.splice(rowIndex, 1);
        renderTable();
    }
});

refreshBtn.addEventListener("click", () => {
    fetchTasks();
});

createBtn.addEventListener("click", () => {
        state.items = [createEmptyTask(), ...state.items];
        renderTable();
        updateTotalBalance();
        showMessage("已新增一行，请补充全量字段后点击保存。");
});

async function handleDelete(rowIndex) {
    const row = state.items[rowIndex];
    if (!row) return;
    if (!confirm(`确定删除任务 ${row.task.name || row.task.slug || rowIndex}?`)) {
        return;
    }
    try {
        const response = await fetch(
            `/api/convergence-tasks/${encodeURIComponent(row.task.slug)}`,
            {
                method: "DELETE",
            },
        );
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "删除失败");
        }
        state.items.splice(rowIndex, 1);
        renderTable();
        updateTotalBalance();
        showMessage("任务已删除", "success");
    } catch (err) {
        showMessage(err.message, "error");
    }
}

// ========== 地址列表功能 ==========

const accountsState = {
    items: [],
    loading: false,
};

function formatPolBalance(value) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return `${value}`;
    }
    return numeric >= 1 ? numeric.toFixed(4) : numeric.toFixed(6);
}

async function fetchAccounts() {
    if (accountsState.loading) return;
    accountsState.loading = true;
    setAccountsLoading();
    try {
        const response = await fetch("/api/accounts");
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "加载地址列表失败");
        }
        const payload = await response.json();
        accountsState.items = payload.items || [];
        renderAccounts();
    } catch (err) {
        showMessage(err.message, "error");
        accountsState.items = [];
        renderAccounts();
    } finally {
        accountsState.loading = false;
    }
}

function setAccountsLoading() {
    accountsTableBody.innerHTML = `<tr><td class="empty" colspan="5">加载中...</td></tr>`;
}

function renderAccounts() {
    accountsTableBody.innerHTML = "";
    if (!accountsState.items.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "empty";
        cell.colSpan = 5;
        cell.textContent = "暂无地址";
        row.appendChild(cell);
        accountsTableBody.appendChild(row);
        return;
    }

    accountsState.items.forEach((account) => {
        const tr = document.createElement("tr");
        tr.dataset.pkIdx = account.pkIdx;
        // 存储原始余额数据，供最大额度按钮使用
        tr.dataset.polBalance = account.polBalance != null ? String(account.polBalance) : "0";
        tr.dataset.usdcBalance = account.usdcBalance != null ? String(account.usdcBalance) : "0";

        const pkIdxCell = document.createElement("td");
        pkIdxCell.textContent = account.pkIdx;
        tr.appendChild(pkIdxCell);

        const addressCell = document.createElement("td");
        addressCell.textContent = account.address;
        addressCell.style.fontFamily = "monospace";
        addressCell.style.fontSize = "12px";
        tr.appendChild(addressCell);

        const polCell = document.createElement("td");
        polCell.textContent = formatPolBalance(account.polBalance);
        polCell.style.fontVariantNumeric = "tabular-nums";
        tr.appendChild(polCell);

        const usdcCell = document.createElement("td");
        usdcCell.textContent = formatUsdcBalance(account.usdcBalance);
        usdcCell.style.fontVariantNumeric = "tabular-nums";
        tr.appendChild(usdcCell);

        const actionsCell = document.createElement("td");
        actionsCell.className = "actions";
        actionsCell.appendChild(createAccountActions(account));
        tr.appendChild(actionsCell);

        accountsTableBody.appendChild(tr);
    });
}

function createAccountActions(account) {
    const fragment = document.createDocumentFragment();

    const transferPolBtn = document.createElement("button");
    transferPolBtn.textContent = "划转 POL";
    transferPolBtn.className = "transfer-btn";
    transferPolBtn.dataset.action = "transfer-pol";
    transferPolBtn.dataset.pkIdx = account.pkIdx;
    transferPolBtn.dataset.address = account.address;
    fragment.appendChild(transferPolBtn);

    const transferUsdcBtn = document.createElement("button");
    transferUsdcBtn.textContent = "划转 USDC.e";
    transferUsdcBtn.className = "transfer-btn";
    transferUsdcBtn.dataset.action = "transfer-usdc";
    transferUsdcBtn.dataset.pkIdx = account.pkIdx;
    transferUsdcBtn.dataset.address = account.address;
    fragment.appendChild(transferUsdcBtn);

    return fragment;
}

// ========== 模态对话框功能 ==========

const transferModal = document.getElementById("transfer-modal");
const transferModalTitle = document.getElementById("transfer-modal-title");
const transferToInput = document.getElementById("transfer-to");
const transferAmountInput = document.getElementById("transfer-amount");
const transferUnit = document.getElementById("transfer-unit");
const transferFromAddress = document.getElementById("transfer-from-address");
const transferCancelBtn = document.getElementById("transfer-cancel");
const transferConfirmBtn = document.getElementById("transfer-confirm");
const transferMaxBtn = document.getElementById("transfer-max-btn");
const modalCloseBtn = document.querySelector(".modal-close");
const modalOverlay = document.querySelector(".modal-overlay");

let currentTransferType = null;
let currentPkIdx = null;
let currentFromAddress = null;

function isValidAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidAmount(amount) {
    const num = parseFloat(amount);
    return !isNaN(num) && num > 0 && isFinite(num);
}

function showTransferModal(type, pkIdx, fromAddress) {
    currentTransferType = type;
    currentPkIdx = pkIdx;
    currentFromAddress = fromAddress;

    const tokenName = type === "pol" ? "POL" : "USDC.e";
    transferModalTitle.textContent = `划转 ${tokenName}`;
    transferUnit.textContent = tokenName;
    transferFromAddress.textContent = fromAddress;
    transferToInput.value = "";
    transferAmountInput.value = "";
    transferToInput.classList.remove("error");
    transferAmountInput.classList.remove("error");

    // 重置按钮状态
    transferConfirmBtn.disabled = false;
    transferConfirmBtn.textContent = "确认划转";

    transferModal.style.display = "flex";
    setTimeout(() => {
        transferToInput.focus();
    }, 100);
}

function setMaxAmount() {
    if (!currentPkIdx || !currentTransferType) return;

    // 直接从表格行读取余额数据
    const row = accountsTableBody.querySelector(`tr[data-pk-idx="${currentPkIdx}"]`);
    if (!row) {
        showMessage("无法找到账户信息", "error");
        return;
    }

    let maxAmount = null;
    if (currentTransferType === "pol") {
        // 对于POL，读取全额-0.01
        const polBalance = parseFloat(row.dataset.polBalance || 0);
        if (polBalance > 0.01) {
            maxAmount = (polBalance - 0.01).toFixed(6);
        } else {
            maxAmount = "0";
        }
    } else if (currentTransferType === "usdc") {
        // 对于USDC.e，读取全额
        const usdcBalance = parseFloat(row.dataset.usdcBalance || 0);
        if (usdcBalance > 0) {
            // 保留6位小数精度
            maxAmount = usdcBalance.toFixed(6);
        } else {
            maxAmount = "0";
        }
    }

    if (maxAmount !== null && parseFloat(maxAmount) > 0) {
        transferAmountInput.value = maxAmount;
        transferAmountInput.classList.remove("error");
    } else {
        showMessage("账户余额不足", "error");
    }
}

function hideTransferModal() {
    transferModal.style.display = "none";
    currentTransferType = null;
    currentPkIdx = null;
    currentFromAddress = null;
}

function validateTransferForm() {
    let isValid = true;
    const to = transferToInput.value.trim();
    const amount = transferAmountInput.value.trim();

    if (!to || !isValidAddress(to)) {
        transferToInput.classList.add("error");
        isValid = false;
    } else {
        transferToInput.classList.remove("error");
    }

    if (!amount || !isValidAmount(amount)) {
        transferAmountInput.classList.add("error");
        isValid = false;
    } else {
        transferAmountInput.classList.remove("error");
    }

    return isValid;
}

async function executeTransfer() {
    if (!validateTransferForm()) {
        return;
    }

    const to = transferToInput.value.trim();
    const amount = transferAmountInput.value.trim();
    const tokenName = currentTransferType === "pol" ? "POL" : "USDC.e";

    transferConfirmBtn.disabled = true;
    transferConfirmBtn.textContent = "划转中...";

    try {
        showMessage(`正在划转 ${amount} ${tokenName}...`, "");
        const endpoint = currentTransferType === "pol"
            ? `/api/accounts/${currentPkIdx}/transfer-pol`
            : `/api/accounts/${currentPkIdx}/transfer-usdc`;
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to, amount }),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "划转失败");
        }

        const result = await response.json();
        // 重置按钮状态
        transferConfirmBtn.disabled = false;
        transferConfirmBtn.textContent = "确认划转";
        hideTransferModal();
        showMessage(
            `划转成功! Hash: ${result.hash.slice(0, 10)}...`,
            "success",
        );
        setTimeout(() => {
            fetchAccounts();
        }, 2000);
    } catch (err) {
        showMessage(err.message, "error");
        transferConfirmBtn.disabled = false;
        transferConfirmBtn.textContent = "确认划转";
    }
}

transferConfirmBtn.addEventListener("click", executeTransfer);
transferCancelBtn.addEventListener("click", hideTransferModal);
transferMaxBtn.addEventListener("click", setMaxAmount);
modalCloseBtn.addEventListener("click", hideTransferModal);
modalOverlay.addEventListener("click", hideTransferModal);

transferToInput.addEventListener("input", () => {
    transferToInput.classList.remove("error");
});

transferAmountInput.addEventListener("input", () => {
    transferAmountInput.classList.remove("error");
});

transferToInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        transferAmountInput.focus();
    }
});

transferAmountInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        executeTransfer();
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && transferModal.style.display === "flex") {
        hideTransferModal();
    }
});

async function handleTransfer(type, pkIdx, fromAddress) {
    showTransferModal(type, pkIdx, fromAddress);
}

accountsTableBody.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const pkIdx = btn.dataset.pkIdx;
    const address = btn.dataset.address;

    if (action === "transfer-pol") {
        handleTransfer("pol", pkIdx, address);
    } else if (action === "transfer-usdc") {
        handleTransfer("usdc", pkIdx, address);
    }
});

refreshAccountsBtn.addEventListener("click", () => {
    fetchAccounts();
});

// ========== 余额图表功能 ==========

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_COLORS = [
    "#00c2ff",
    "#22c55e",
    "#f87171",
    "#a78bfa",
    "#f472b6",
    "#f97316",
    "#38bdf8",
    "#facc15",
];

const balanceChartContainer = document.getElementById("balance-chart-container");
const balanceChartDaysSelect = document.getElementById("balance-chart-days");
const refreshChartBtn = document.getElementById("btn-refresh-chart");

const balanceChartState = {
    loading: false,
    data: [],
    days: 7,
    allSeries: [], // 保存所有曲线数据
    selectedSeries: new Set(), // 选中的曲线索引集合
};

function getChartColor(index) {
    return CHART_COLORS[index % CHART_COLORS.length];
}

async function fetchBalanceHistory() {
    if (balanceChartState.loading) return;
    balanceChartState.loading = true;
    setChartLoading();
    try {
        const days = balanceChartState.days;
        const response = await fetch(`/api/balance-history?days=${days}`);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "加载余额历史失败");
        }
        const payload = await response.json();
        balanceChartState.data = payload.items || [];
        renderBalanceChart();
    } catch (err) {
        showMessage(err.message, "error");
        balanceChartState.data = [];
        renderBalanceChart();
    } finally {
        balanceChartState.loading = false;
    }
}

function setChartLoading() {
    balanceChartContainer.innerHTML = '<div class="chart-loading">加载中...</div>';
}

function renderBalanceChart() {
    balanceChartContainer.innerHTML = "";

    if (!balanceChartState.data.length) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "暂无余额数据";
        balanceChartContainer.appendChild(empty);
        return;
    }

    // 按业务地址组分组数据（每100个pkIdx为一个业务地址）
    // 当同一小时内同一组有多个pkIdx时，选择最大pkIdx的余额
    const dataByGroup = new Map(); // groupId -> { maxPkIdx, address, points: [{time, balance, pkIdx}] }
    balanceChartState.data.forEach((log) => {
        const groupId = Math.floor(log.pk_idx / 100);

        if (!dataByGroup.has(groupId)) {
            dataByGroup.set(groupId, {
                groupId,
                maxPkIdx: log.pk_idx,
                address: log.address,
                points: [],
            });
        }
        const entry = dataByGroup.get(groupId);
        // 更新最大pkIdx和对应的地址
        if (log.pk_idx > entry.maxPkIdx) {
            entry.maxPkIdx = log.pk_idx;
            entry.address = log.address;
        }
        // 保存所有数据点，包含pkIdx信息
        entry.points.push({
            time: new Date(log.log_time).getTime(),
            balance: log.balance,
            pkIdx: log.pk_idx,
        });
    });

    // 计算总余额曲线
    // 方法：将时间点对齐到小时级别，因为一小时内只会记录一次
    // 1. 按小时对齐所有时间点
    const alignToHour = (timestamp) => {
        const date = new Date(timestamp);
        date.setMinutes(0, 0, 0); // 将分钟、秒和毫秒归零
        return date.getTime();
    };

    // 2. 按小时分组所有业务地址组的余额记录
    // 对于每个组，如果同一小时内有多条记录（不同pkIdx），选择最大pkIdx的
    const balanceByHour = new Map(); // hourTimestamp -> { groupId -> { time, balance, pkIdx } }
    dataByGroup.forEach((entry, groupId) => {
        entry.points.forEach((point) => {
            const hourTime = alignToHour(point.time);
            if (!balanceByHour.has(hourTime)) {
                balanceByHour.set(hourTime, new Map());
            }
            const hourData = balanceByHour.get(hourTime);
            const existing = hourData.get(groupId);
            // 如果同一小时内同一组有多个pkIdx，选择最大pkIdx的
            if (!existing || point.pkIdx > existing.pkIdx ||
                (point.pkIdx === existing.pkIdx && point.time > existing.time)) {
                hourData.set(groupId, {
                    time: point.time,
                    balance: point.balance,
                    pkIdx: point.pkIdx,
                });
            }
        });
    });

    // 3. 计算每个小时时间点的总余额
    const sortedHours = Array.from(balanceByHour.keys()).sort((a, b) => a - b);
    const totalPoints = sortedHours.map((hourTime) => {
        const hourData = balanceByHour.get(hourTime);
        let total = 0;
        hourData.forEach(({ balance }) => {
            total += balance;
        });
        return { time: hourTime, balance: total };
    });

    // 准备所有曲线数据
    const series = [];
    let colorIndex = 0;

    // 添加每个业务地址组的曲线（按小时对齐，同一小时内选择最大pkIdx的余额）
    dataByGroup.forEach((entry) => {
        // 按小时对齐该组的点，同一小时内选择最大pkIdx的
        const addressBalanceByHour = new Map(); // hourTimestamp -> { time, balance, pkIdx }
        entry.points.forEach((point) => {
            const hourTime = alignToHour(point.time);
            const existing = addressBalanceByHour.get(hourTime);
            // 如果同一小时内有多条记录（不同pkIdx），选择最大pkIdx的
            if (!existing || point.pkIdx > existing.pkIdx ||
                (point.pkIdx === existing.pkIdx && point.time > existing.time)) {
                addressBalanceByHour.set(hourTime, {
                    time: hourTime,
                    balance: point.balance,
                    pkIdx: point.pkIdx,
                });
            }
        });

        // 转换为排序后的点数组
        const alignedPoints = Array.from(addressBalanceByHour.values())
            .map(({ time, balance }) => ({ time, balance }))
            .sort((a, b) => a.time - b.time);

        if (alignedPoints.length > 0) {
            series.push({
                points: alignedPoints,
                color: getChartColor(colorIndex++),
                label: `#${entry.maxPkIdx} ${entry.address.slice(0, 8)}...`,
                currentValue: alignedPoints[alignedPoints.length - 1].balance,
            });
        }
    });

    // 添加总余额曲线
    if (totalPoints.length > 0) {
        series.push({
            points: totalPoints,
            color: "#22c55e",
            label: "总余额",
            currentValue: totalPoints[totalPoints.length - 1].balance,
            isTotal: true,
        });
    }

    if (series.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "暂无数据";
        balanceChartContainer.appendChild(empty);
        return;
    }

    // 保存所有曲线数据
    balanceChartState.allSeries = series;

    // 初始化选中状态：默认只显示总余额曲线
    if (balanceChartState.selectedSeries.size === 0) {
        // 找到总余额曲线的索引（通常是最后一个）
        const totalIndex = series.findIndex((s) => s.isTotal);
        if (totalIndex >= 0) {
            balanceChartState.selectedSeries.add(totalIndex);
        } else {
            // 如果没有总余额曲线，默认选中最后一条
            if (series.length > 0) {
                balanceChartState.selectedSeries.add(series.length - 1);
            }
        }
    } else {
        // 如果已有选中状态，确保索引有效
        const validIndices = new Set();
        balanceChartState.selectedSeries.forEach((index) => {
            if (index < series.length) {
                validIndices.add(index);
            }
        });
        balanceChartState.selectedSeries = validIndices;
        // 如果所有索引都无效，默认只显示总余额曲线
        if (validIndices.size === 0) {
            const totalIndex = series.findIndex((s) => s.isTotal);
            if (totalIndex >= 0) {
                balanceChartState.selectedSeries.add(totalIndex);
            } else if (series.length > 0) {
                balanceChartState.selectedSeries.add(series.length - 1);
            }
        }
    }

    // 渲染合并图表
    const chartCard = createCombinedChartCard(series);
    balanceChartContainer.appendChild(chartCard);
}

function createCombinedChartCard(series) {
    const card = document.createElement("div");
    card.className = "balance-chart-item";

    // 创建图例头部
    const head = document.createElement("div");
    head.className = "balance-chart-item-head";
    const title = document.createElement("strong");
    title.textContent = "余额曲线";
    head.appendChild(title);

    // 创建图例
    const legend = document.createElement("div");
    legend.className = "balance-chart-legend";
    series.forEach((s, index) => {
        const isSelected = balanceChartState.selectedSeries.has(index);
        const legendItem = document.createElement("div");
        legendItem.className = "balance-chart-legend-item";
        legendItem.dataset.seriesIndex = index;
        if (s.isTotal) {
            legendItem.classList.add("total-legend");
        }
        if (!isSelected) {
            legendItem.classList.add("legend-item-unselected");
        }

        // 复选框
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "legend-checkbox";
        checkbox.checked = isSelected;
        checkbox.dataset.seriesIndex = index;
        checkbox.addEventListener("change", handleSeriesToggle);

        const dot = document.createElement("span");
        dot.className = "legend-dot";
        dot.style.backgroundColor = s.color;

        const label = document.createElement("span");
        label.className = "legend-label";
        label.textContent = s.label;

        const value = document.createElement("span");
        value.className = "legend-value";
        value.textContent = formatUsdcBalance(s.currentValue);

        legendItem.appendChild(checkbox);
        legendItem.appendChild(dot);
        legendItem.appendChild(label);
        legendItem.appendChild(value);
        legend.appendChild(legendItem);
    });

    head.appendChild(legend);
    card.appendChild(head);

    // 创建合并图表（只显示选中的曲线）
    const filteredSeries = series.filter((_, index) => balanceChartState.selectedSeries.has(index));

    if (filteredSeries.length === 0) {
        const emptyMsg = document.createElement("div");
        emptyMsg.className = "chart-empty";
        emptyMsg.textContent = "请至少选择一条曲线";
        card.appendChild(emptyMsg);
    } else {
        const svg = buildCombinedBalanceChart(filteredSeries);
        svg.dataset.chartId = "balance-chart-svg";
        card.appendChild(svg);
    }

    return card;
}

function handleSeriesToggle(event) {
    const index = parseInt(event.target.dataset.seriesIndex, 10);
    const legendItem = event.target.closest(".balance-chart-legend-item");

    if (event.target.checked) {
        balanceChartState.selectedSeries.add(index);
        legendItem?.classList.remove("legend-item-unselected");
    } else {
        // 至少保留一条曲线
        if (balanceChartState.selectedSeries.size <= 1) {
            event.target.checked = true;
            return;
        }
        balanceChartState.selectedSeries.delete(index);
        legendItem?.classList.add("legend-item-unselected");
    }

    // 重新渲染图表
    const chartCard = balanceChartContainer.querySelector(".balance-chart-item");
    if (chartCard) {
        const filteredSeries = balanceChartState.allSeries.filter(
            (_, idx) => balanceChartState.selectedSeries.has(idx)
        );

        const oldSvg = chartCard.querySelector('[data-chart-id="balance-chart-svg"]');
        const oldEmpty = chartCard.querySelector(".chart-empty");

        if (filteredSeries.length === 0) {
            if (oldSvg) oldSvg.remove();
            if (!oldEmpty) {
                const emptyMsg = document.createElement("div");
                emptyMsg.className = "chart-empty";
                emptyMsg.textContent = "请至少选择一条曲线";
                chartCard.appendChild(emptyMsg);
            }
        } else {
            if (oldEmpty) oldEmpty.remove();
            if (oldSvg) {
                const newSvg = buildCombinedBalanceChart(filteredSeries);
                newSvg.dataset.chartId = "balance-chart-svg";
                oldSvg.replaceWith(newSvg);
            } else {
                const newSvg = buildCombinedBalanceChart(filteredSeries);
                newSvg.dataset.chartId = "balance-chart-svg";
                chartCard.appendChild(newSvg);
            }
        }
    }
}

function buildCombinedBalanceChart(series) {
    const width = 1200;
    const height = 500;
    const padding = { top: 30, right: 80, bottom: 60, left: 20 };

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.classList.add("balance-chart-svg");

    // 计算所有曲线的统一时间范围和余额范围
    const allTimes = series.flatMap((s) => s.points.map((p) => p.time));
    const allBalances = series.flatMap((s) => s.points.map((p) => p.balance));
    const minX = Math.min(...allTimes);
    const maxX = Math.max(...allTimes);
    let minY = Math.min(...allBalances);
    let maxY = Math.max(...allBalances);

    if (minY === maxY) {
        const adjust = minY === 0 ? 1 : Math.abs(minY) * 0.1;
        minY -= adjust;
        maxY += adjust;
    }

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const scaleX = (value) => {
        if (maxX === minX) return padding.left + chartWidth / 2;
        return padding.left + ((value - minX) / (maxX - minX)) * chartWidth;
    };

    const scaleY = (value) => {
        if (maxY === minY) return padding.top + chartHeight / 2;
        return padding.top + chartHeight - ((value - minY) / (maxY - minY)) * chartHeight;
    };

    // 绘制网格线
    for (let i = 0; i <= 4; i++) {
        const line = document.createElementNS(SVG_NS, "line");
        const y = padding.top + (chartHeight / 4) * i;
        line.setAttribute("x1", padding.left);
        line.setAttribute("x2", padding.left + chartWidth);
        line.setAttribute("y1", y);
        line.setAttribute("y2", y);
        line.setAttribute("stroke", "rgba(255,255,255,0.05)");
        line.setAttribute("stroke-width", "1");
        svg.appendChild(line);
    }

    // 绘制 Y 轴刻度（右侧）
    for (let i = 0; i <= 4; i++) {
        const value = minY + ((maxY - minY) / 4) * i;
        const y = scaleY(value);
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", width - padding.right + 10);
        label.setAttribute("y", y + 5);
        label.setAttribute("text-anchor", "start");
        label.setAttribute("fill", "rgba(255,255,255,0.6)");
        label.setAttribute("font-size", "12");
        label.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
        label.textContent = value.toFixed(2);
        svg.appendChild(label);
    }

    // 绘制 X 轴刻度（时间）
    const timeLabels = [];
    for (let i = 0; i <= 4; i++) {
        const time = minX + ((maxX - minX) / 4) * i;
        timeLabels.push(time);
    }
    timeLabels.forEach((time) => {
        const x = scaleX(time);
        const date = new Date(time);
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", x);
        label.setAttribute("y", height - padding.bottom + 20);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "rgba(255,255,255,0.6)");
        label.setAttribute("font-size", "11");
        label.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
        label.textContent = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
        svg.appendChild(label);
    });

    // 绘制所有曲线
    series.forEach((s) => {
        const path = document.createElementNS(SVG_NS, "path");

        // 生成平滑曲线路径
        let d = "";
        if (s.points.length > 0) {
            if (s.points.length === 1) {
                // 只有一个点时，画一个点
                const x = scaleX(s.points[0].time).toFixed(2);
                const y = scaleY(s.points[0].balance).toFixed(2);
                d = `M${x} ${y}`;
            } else if (s.points.length === 2) {
                // 两个点时，画直线
                const x1 = scaleX(s.points[0].time).toFixed(2);
                const y1 = scaleY(s.points[0].balance).toFixed(2);
                const x2 = scaleX(s.points[1].time).toFixed(2);
                const y2 = scaleY(s.points[1].balance).toFixed(2);
                d = `M${x1} ${y1} L${x2} ${y2}`;
            } else {
                // 多个点时，使用平滑曲线
                const points = s.points.map((point) => ({
                    x: scaleX(point.time),
                    y: scaleY(point.balance),
                }));

                // 使用 Catmull-Rom 样条曲线生成平滑路径
                d = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
                for (let i = 0; i < points.length - 1; i++) {
                    const p0 = i > 0 ? points[i - 1] : points[i];
                    const p1 = points[i];
                    const p2 = points[i + 1];
                    const p3 = i < points.length - 2 ? points[i + 2] : points[i + 1];

                    // Catmull-Rom 到 Bezier 转换
                    const cp1x = p1.x + (p2.x - p0.x) / 6;
                    const cp1y = p1.y + (p2.y - p0.y) / 6;
                    const cp2x = p2.x - (p3.x - p1.x) / 6;
                    const cp2y = p2.y - (p3.y - p1.y) / 6;

                    d += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
                }
            }
        }

        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", s.color);
        path.setAttribute("stroke-width", s.isTotal ? "3" : "2");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        // 移除虚线样式，改为实线
        svg.appendChild(path);

        // 绘制数据点标记
        s.points.forEach((point) => {
            const circle = document.createElementNS(SVG_NS, "circle");
            const x = scaleX(point.time);
            const y = scaleY(point.balance);
            circle.setAttribute("cx", x.toFixed(2));
            circle.setAttribute("cy", y.toFixed(2));
            circle.setAttribute("r", s.isTotal ? "4" : "3");
            circle.setAttribute("fill", s.color);
            circle.setAttribute("stroke", "#000");
            circle.setAttribute("stroke-width", "1");
            svg.appendChild(circle);
        });
    });

    return svg;
}

balanceChartDaysSelect.addEventListener("change", (e) => {
    balanceChartState.days = parseInt(e.target.value, 10);
    fetchBalanceHistory();
});

refreshChartBtn.addEventListener("click", () => {
    fetchBalanceHistory();
});

fetchTasks();
fetchAccounts();
fetchBalanceHistory();
