// Making extension firefox & chrome compatible
const extensionAPI = typeof browser !== "undefined" ? browser : chrome;

import {
    renderAlert,
    renderDate,
    renderHref,
    renderFrame,
    renderSink,
    renderData,
    renderTrace,
    renderDebug
} from "./render.js";

import {
    // Table
    handleTableRedraw,
    // Show modal
    handleShowData,
    handleShowTrace,
    // Modal
    handleCloseModal,
    handleOutModal,
    // Filter
    handleFilterData,
    handleFilterButton,
    handleAdvancedSearch,
    handleFilterSpan,
    handleAlertsFilter,
    handleClearAllFilters,
    // Toolbar
    handleConfigSwitch,
    handleCanaryChange,
    handleCanaryCopy,
    handleModeToggle,
    // Legend
    handleToggleLegend,
    // Debug
    handleRedirection,
    handleStartDebug,
    // Fullscreen
    handleFullscreen,
    // Misc
    handleRemoveRow,
    // Buttons
    handleImportClick,
    handleImport,
    handleClear,
    handleExport,
    handleSettingsNavigation
} from "./handlers.js";

import {
    getHighlightColor,
    getHighlightBg,
    rowSeverity,
    sanitizeHtml
} from "./utils.js";

const initColors = () => {
    window.colorsData = {
        textColor: "#C6C6CA",
        backgroundColor: "#292A2D"
    }
    extensionAPI.storage.local.get("colorsData", (data) => {
        if (data.colorsData) {
            window.colorsData = data.colorsData;
        }
        var root = document.documentElement;
        root.style.setProperty("--text-color", window.colorsData["textColor"]);
        root.style.setProperty("--background-color", window.colorsData["backgroundColor"]);
        const highlight = getHighlightColor(window.colorsData["backgroundColor"], window.colorsData["textColor"]);
        root.style.setProperty("--highlight-color", highlight);
        root.style.setProperty("--highlight-bg", getHighlightBg(highlight));
        document.body.style.opacity = "1";
    });
}

// Multi-select tag state shared with the filter handlers
window.activeTags = new Set();
window.alertsOnly = false;

const initButtons = () => {
    window.hookKeys = [];
    extensionAPI.storage.local.get("hooksData", (data) => {
        if (data.hooksData) {
            window.defaultHookKeys = Object.keys(data.hooksData.hooksSettings[0].content["hooks"]);
            window.hookKeys = window.defaultHookKeys.concat(Object.keys(data.hooksData.hooksSettings[data.hooksData.selectedHook].content["hooks"]));
        }
        const allActive = window.activeTags.size === 0 ? " chip-active" : "";
        $("#filter-buttons").html(`
        <button class="filter-button${allActive}" data-filter="All"><b>ALL</b></button>
        ${window.hookKeys.map(k => `<button class="filter-button${window.activeTags.has(k) ? " chip-active" : ""}" data-filter="${sanitizeHtml(k)}"><b>${sanitizeHtml(k)}</b></button>`).join(" ")}
        `)
        $(".filter-button").on("click", handleFilterButton);
    })
}

// Populate the hunt toolbar (config switcher, canary, recon/hunt mode) from storage
const initToolbar = () => {
    extensionAPI.storage.local.get("hooksData", (data) => {
        if (!data.hooksData) return;
        window.panelHooksData = data.hooksData;
        const settings = data.hooksData.hooksSettings || [];
        const selected = data.hooksData.selectedHook;

        // Config switcher — skip index 0 (GLOBAL, auto-merged, not selectable)
        const opts = settings
            .map((c, i) => ({ i, name: c.name }))
            .filter(o => o.i !== 0)
            .map(o => `<option value="${o.i}"${o.i === selected ? " selected" : ""}>${sanitizeHtml(o.name)}</option>`)
            .join("");
        $("#panel-hook").html(opts);

        // Canary + mode reflect the *selected* config
        const content = settings[selected] && settings[selected].content ? settings[selected].content : {};
        const canary = content.globals && content.globals.canary ? content.globals.canary : "";
        $("#panel-canary").val(canary);

        const wildcard = content.config && content.config["*"] && Array.isArray(content.config["*"].match)
            ? content.config["*"].match.join(" ") : "";
        const isHunt = wildcard.includes("globals.canary");
        const isRecon = /return\s+\/\.\*\//.test(wildcard) && !isHunt;
        $("#mode-recon").toggleClass("mode-active", isRecon);
        $("#mode-hunt").toggleClass("mode-active", isHunt);
    });
}

const updateUITable = () => {
    // When using window.table.colReorder.order to update order, it uses the current col order as a reference
    var updateOrder  = [];
    var currentOrder = window.table.colReorder.order();
    for (const c of window.tableConfig.colOrder) {
        updateOrder.push(currentOrder.indexOf(c));
    }

    // Devtools table has one more column for row deletion
    updateOrder.push(11);
    window.table.colReorder.order(updateOrder);
    currentOrder = window.table.colReorder.order();

    for (const colName of window.tableConfig.colIds) {
        var colVisibility = window.tableConfig.colVisibility[colName];
        var colIndex = currentOrder.indexOf(window.tableConfig.colIds.indexOf(colName));

        if (colVisibility !== window.table.column(colIndex).visible()) {
            window.table.column(colIndex).visible(colVisibility);
        }
    }
    window.table.columns.adjust().draw();
}

// Fill the available vertical space with the scroll body
const computeScrollY = () => {
    const reserved = 260; // toolbar + filters + footer chrome
    return Math.max(220, window.innerHeight - reserved) + "px";
}

const initTable = () => {
    window.tableConfig = {
        colIds: [ "dupKey", "tag", "alert", "type", "date", "href", "frame", "sink", "data", "trace", "debug" ],
        colVisibility: {
            "dupKey": false, "tag": false, "alert": true, "type": false, "date": true, "href": true, "frame": true, "sink": true, "data": true, "trace": true, "debug": true
        },
        colOrder: [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ]
    }
    extensionAPI.storage.local.get("tableConfig", (data) => {
        if (data.tableConfig) {
            window.tableConfig = data.tableConfig;
        }
        updateUITable();
    });

    window.table = $("#table").DataTable({
        order: [[window.tableConfig.colIds.indexOf("date"), "desc"]],
        colReorder: true,
        paging: true,
        deferRender: true,
        scrollCollapse: true,
        scrollY: computeScrollY(),
        data: [],
        search: {
            smart: false
        },
        columnDefs: [{
            targets: [window.tableConfig.colIds.indexOf("dupKey"), window.tableConfig.colIds.indexOf("tag")],
            visible: false,
            searchable: true
        }],
        columns: [
            { data: "dupKey", render: $.fn.dataTable.render.text() }, // Avoid datatable DOM Based XSS...
            { data: "tag", render: $.fn.dataTable.render.text() },
            { data: "badge", render: renderAlert},
            { data: "type", render: $.fn.dataTable.render.text() },
            { data: "date", render: renderDate},
            { data: "href", render: renderHref},
            { data: "frame", render: renderFrame},
            { data: "sink", render: renderSink},
            { data: "data", render: renderData},
            { data: "trace", render: renderTrace},
            { data: "debug", render: renderDebug},
            { title: "", data: null, orderable: false, render: (data, type, row) => { return `<span data-dupKey="${row.dupKey}" class="remove-one">&times;</span>` }}
        ],
        createdRow: (rowEl, data) => {
            const sev = rowSeverity(data);
            if (sev) rowEl.classList.add(`sev-${sev}`);
        },
        drawCallback: handleTableRedraw
    });

    // Show modal
    $("#table").on("click", ".show-data", handleShowData);
    $("#table").on("click", ".show-trace", handleShowTrace);

    // Modal event
    $("#modal-content").on("click", ".close", handleCloseModal);
    window.onclick = handleOutModal;

    // Debug
    $("#table").on("click", ".goto-link", handleRedirection);
    $("#table").on("click", ".start-debug", handleStartDebug);

    // Fullscreen
    $("#fullscreen").on("click", handleFullscreen);

    // Filters
    $("#filter-data").on("keyup", handleFilterData);
    $("#advanced-search").on("submit", handleAdvancedSearch);
    $("#table").on("click", ".filter-span", handleFilterSpan);
    $("#alerts-only").on("click", handleAlertsFilter);
    $("#clear-filters").on("click", handleClearAllFilters);
    // Clicking an alert bell jumps to the alerts-only view
    $("#table").on("click", ".alert-bell", () => {
        if (!$("#alerts-only").hasClass("active")) $("#alerts-only").click();
    });

    // Toolbar
    $("#panel-hook").on("change", handleConfigSwitch);
    $("#panel-canary").on("change", handleCanaryChange);
    $("#canary-copy").on("click", handleCanaryCopy);
    $("#mode-recon").on("click", handleModeToggle);
    $("#mode-hunt").on("click", handleModeToggle);

    // Legend
    $("#legend-toggle").on("click", handleToggleLegend);
    $("#legend-close").on("click", handleToggleLegend);

    // Remove line
    $("#table").on("click", ".remove-one", handleRemoveRow);

    // Buttons
    $("#import").on("click",handleImportClick);
    $("#importFile").on("change", handleImport);
    $("#remove").on("click", handleClear);
    $("#export").on("click", handleExport);
    $("#settings").on("click", handleSettingsNavigation);
}

// Refresh the "Alerts (N)" count + the empty-state overlay
const updateAlertsCount = () => {
    if (!window.table) return;
    let n = 0;
    window.table.rows().every(function () {
        if (this.data() && this.data().badge) n++;
    });
    $("#alerts-count").text(`(${n})`);
}

const updateEmptyState = () => {
    if (!window.table) return;
    const empty = window.table.rows().count() === 0;
    const el = document.getElementById("empty-state");
    if (!el) return;
    if (!empty) {
        el.hidden = true;
        return;
    }
    extensionAPI.storage.local.get(["allowedDomains", "hooksData"], (data) => {
        const nDomains = (data.allowedDomains || []).length;
        let configName = "—";
        if (data.hooksData && data.hooksData.hooksSettings[data.hooksData.selectedHook]) {
            configName = data.hooksData.hooksSettings[data.hooksData.selectedHook].name;
        }
        el.innerHTML = `
            <h3>No sink hits captured yet</h3>
            <ul>
                <li><span class="${nDomains ? "es-ok" : "es-todo"}">${nDomains ? "✓" : "•"}</span> Allowed domains: ${nDomains} configured ${nDomains ? "" : "— add the target in the popup or settings"}</li>
                <li><span class="es-ok">✓</span> Active config: <b>${sanitizeHtml(configName)}</b></li>
                <li><span class="es-todo">•</span> Interact with the page to trigger hooked sinks</li>
            </ul>
            <p class="es-hint">Recon mode logs every sink hit. Switch to Hunt and seed your canary
            (<b>${sanitizeHtml($("#panel-canary").val() || "set one above")}</b>) into inputs to filter the table to your own data.</p>`;
        el.hidden = false;
    });
}

// Coalesce incoming rows into one draw per tick instead of one draw per message.
// setTimeout (not requestAnimationFrame) so rows still flush when the panel is
// backgrounded — rAF is paused in hidden tabs.
window.pendingRows = [];
let flushScheduled = false;
const flushPending = () => {
    flushScheduled = false;
    if (!window.pendingRows.length) return;
    const batch = window.pendingRows;
    window.pendingRows = [];
    const table = $("#table").DataTable();
    table.rows.add(batch).draw(false);
    updateAlertsCount();
    updateEmptyState();
}

const handleMessage = (data) => {
    window.pendingRows.push(data);
    if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(flushPending, 50);
    }
}

const init = (data) => {
    let table = $("#table").DataTable();
    table.rows.add(data);
    table.draw();
    updateAlertsCount();
    updateEmptyState();
}

const main = async () => {
    // Init font-size
    window.devtoolsFontSize = "16px";
    extensionAPI.storage.local.get("devtoolsFontSize", (data) => {
        if (data.devtoolsFontSize) {
            window.devtoolsFontSize = data.devtoolsFontSize;
        }
        document.body.style.opacity = "1";
        document.documentElement.style.setProperty("--font-size", window.devtoolsFontSize);
    });
    // Safety net: never leave the panel invisible if a storage callback stalls
    setTimeout(() => { document.body.style.opacity = "1"; }, 1500);

    window.handleMessage = handleMessage;
    window.initButtons = initButtons;
    window.initToolbar = initToolbar;
    window.initColors = initColors;
    window.updateUITable = updateUITable;
    window.updateEmptyState = updateEmptyState;
    window.updateAlertsCount = updateAlertsCount;
    window.init = init;
    initColors();
    initButtons();
    initToolbar();
    initTable();
    updateEmptyState();

    // Auto-open the legend once
    extensionAPI.storage.local.get("panelLegendSeen", (data) => {
        if (!data.panelLegendSeen) {
            document.getElementById("legend").hidden = false;
            extensionAPI.storage.local.set({ panelLegendSeen: true });
        }
    });

    // Clear the toolbar badge when the analyst is actually looking at the panel
    const clearBadge = () => extensionAPI.runtime.sendMessage({ action: "clearBadge" });
    window.addEventListener("focus", clearBadge);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) clearBadge(); });

    // Esc closes the modal
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") $("#modal").css("display", "none");
    });

    // Handle storage updates
    extensionAPI.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local") {
            for (const [key, values] of Object.entries(changes)) {
                switch (key) {
                    case "hooksData":
                        window.initButtons();
                        window.initToolbar();
                        break;
                    case "colorsData":
                        window.initColors();
                        break;
                    case "tableConfig":
                        window.tableConfig = values.newValue;
                        window.updateUITable();
                        break;
                    case "devtoolsFontSize":
                        document.documentElement.style.setProperty("--font-size", values.newValue);
                        break;
                }
            }
        }
    })
}

const resize = () => {
    if (window.table) {
        const sy = computeScrollY();
        const settings = window.table.settings()[0];
        settings.oScroll.sY = sy;
        if (settings.nScrollBody) {
            $(settings.nScrollBody).css(settings.oScroll.bCollapse ? "max-height" : "height", sy);
        }
        window.table.columns.adjust().draw();
    }
}

// Run as soon as the DOM is ready — and immediately if it already is (module may
// finish evaluating after DOMContentLoaded has already fired).
if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", main);
} else {
    main();
}
window.addEventListener("resize", resize);
