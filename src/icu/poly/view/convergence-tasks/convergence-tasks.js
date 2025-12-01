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
        showMessage("任务已删除", "success");
    } catch (err) {
        showMessage(err.message, "error");
    }
}

fetchTasks();
