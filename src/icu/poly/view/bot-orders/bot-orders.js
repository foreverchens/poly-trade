async function fetchOrders() {
    const loading = document.getElementById("loading");
    const table = document.getElementById("ordersTable");
    const tbody = document.getElementById("ordersBody");

    loading.style.display = "block";
    table.style.display = "none";
    tbody.innerHTML = "";

    function truncateId(id) {
        if (!id) return "-";
        if (id.length <= 13) return id;
        return id.substring(0, 6) + "..." + id.substring(id.length - 4);
    }

    try {
        const res = await fetch("/api/bot-orders?limit=100");
        const data = await res.json();

        if (data.error) {
            loading.textContent = "Error: " + data.message;
            return;
        }

        data.forEach((order, index) => {
            const row = document.createElement("tr");
            const date = new Date(order.createdAt).toLocaleString();

            // Store in global array for edit modal
            window.ordersData = data;

            row.innerHTML = `
                <td>${date}</td>
                <td>${order.marketSlug}</td>
                <td>${order.symbol || "-"}</td>
                <td>${order.outcome}</td>
                <td>${order.entryPrice.toFixed(3)}</td>
                <td>${order.avgWeiPrice !== null && order.avgWeiPrice !== undefined ? order.avgWeiPrice.toFixed(3) : "-"}</td>
                <td>${order.size}</td>
                <td title="${order.entryOrderId}"><small>${truncateId(order.entryOrderId)}</small></td>
                <td title="${order.profitOrderId || ""}"><small>${truncateId(order.profitOrderId)}</small></td>
                <td>${order.profitPrice !== null ? order.profitPrice.toFixed(3) : "-"}</td>
                <td>${order.profit !== null && order.profit !== 0 ? order.profit.toFixed(2) : "-"}</td>
                <td>${order.status || "-"}</td>
                <td>${order.zScore !== null ? order.zScore.toFixed(2) : "-"}</td>
                <td>${order.secondsToEnd !== null ? order.secondsToEnd + "s" : "-"}</td>
                <td>${order.priceChange !== null ? (order.priceChange * 100).toFixed(2) + "%" : "-"}</td>
                <td>${order.isLiquiditySignal ? "Liquidity" : "Normal"}</td>
                <td>
                    <button class="action-btn edit-btn" onclick='openEditModal(${index})'>Edit</button>
                    <button class="action-btn delete-btn" onclick="deleteOrder('${order.id}')">Del</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        loading.style.display = "none";
        table.style.display = "table";
    } catch (err) {
        console.error(err);
        loading.textContent = "Failed to fetch orders";
    }
}

async function deleteOrder(id) {
    if (!confirm("Are you sure you want to delete this order?")) return;

    try {
        const res = await fetch(`/api/bot-orders/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
            fetchOrders();
        } else {
            alert("Failed to delete: " + (data.message || "Unknown error"));
        }
    } catch (err) {
        alert("Error deleting order");
        console.error(err);
    }
}

// Store current order data for profit calculation
let currentOrderData = null;

function calculateProfit() {
    if (!currentOrderData) return;

    const entryPrice = parseFloat(currentOrderData.entryPrice) || 0;
    const profitPrice = parseFloat(document.getElementById("editProfitPrice").value) || 0;
    const size = parseFloat(currentOrderData.size) || 0;

    let profit = "";
    if (profitPrice > 0 && entryPrice > 0 && size > 0) {
        profit = ((profitPrice - entryPrice) * size).toFixed(2);
    }

    document.getElementById("editProfit").value = profit || "-";
}

function openEditModal(index) {
    const order = window.ordersData[index];
    currentOrderData = order; // Store order data for profit calculation

    document.getElementById("editId").value = order.id;
    document.getElementById("editStatus").value = order.status || "pending";
    document.getElementById("editProfitPrice").value = order.profitPrice || "";
    document.getElementById("editProfitOrderId").value = order.profitOrderId || "";

    // Calculate and display profit
    calculateProfit();

    document.getElementById("editModal").style.display = "block";
}

// Add event listener for auto-calculation when page loads
(function setupProfitCalculation() {
    const profitPriceInput = document.getElementById("editProfitPrice");

    if (profitPriceInput) {
        profitPriceInput.addEventListener("input", calculateProfit);
    }
})();

function closeModal() {
    document.getElementById("editModal").style.display = "none";
    currentOrderData = null; // Clear stored order data when closing
}

async function saveOrder() {
    const id = document.getElementById("editId").value;
    const status = document.getElementById("editStatus").value;
    const profitPrice = document.getElementById("editProfitPrice").value;
    const profitOrderId = document.getElementById("editProfitOrderId").value.trim();

    const updateData = {};
    if (status) updateData.status = status;
    if (profitPrice) updateData.profit_price = profitPrice;
    // If profitOrderId is empty string, set to null; otherwise use the value
    if (profitOrderId === "") {
        updateData.profit_order_id = null;
    } else if (profitOrderId) {
        updateData.profit_order_id = profitOrderId;
    }
    // If profit_price is provided, backend will auto-calculate profit

    try {
        const res = await fetch(`/api/bot-orders/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updateData),
        });
        const data = await res.json();

        if (data.error) {
            alert("Failed to update: " + data.message);
        } else {
            closeModal();
            currentOrderData = null; // Clear stored order data
            fetchOrders();
        }
    } catch (err) {
        alert("Error updating order");
        console.error(err);
    }
}

// Close modal if clicking outside
window.onclick = function (event) {
    const modal = document.getElementById("editModal");
    if (event.target == modal) {
        closeModal();
    }
};

// Load on start
fetchOrders();
