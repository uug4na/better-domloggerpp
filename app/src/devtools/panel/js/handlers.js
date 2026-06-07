// Making extension firefox & chrome compatible
const extensionAPI = typeof browser !== "undefined" ? browser : chrome;

import {
    getLink,
    downloadData,
    colorFilter,
    cleanData,
    colorData,
    escapeRegExp,
    unsanitizeHtml
} from "./utils.js"

// Handle table events
function handleTableRedraw() {
    colorFilter();
}

// Show modal events
function handleShowData() {
    const filterData = $("#filter-data").val();
    const data = $(this).attr("data-data");
    $("#modal-content").html(`
    <span class="close">&times;</span>
    <h3 class="mgb-30">Data passed into the sink</h3>
    <div style="text-align:left">
        <p>${filterData ? colorData(cleanData(data), filterData) : cleanData(data)}</p>
    </div>`);
    $("#modal").css("display", "block");
}

function handleShowTrace() {
    const dataTrace = $(this).data("trace").split("||||");
    $("#modal-content").html(`
    <span class="close">&times;</span>
    <h3 class="mgb-10">Stack trace</h3>
    <p class="trace-hint mgb-30">Click a frame to open its source. To pause when this sink fires again, use <b>Break here</b> in the Debug column.</p>
    ${dataTrace.map(l => `<p><a href="#" class="no-deco open-view-source" data-url="${getLink(l)}" target="_blank">${l}</a></p>`).join("")}
    `);
    $("#modal").css("display", "block");

    // Chromium blocks a tag to open view-source link from extension's devtools
    $(".open-view-source").on("click", function(e) {
        e.preventDefault();
        const url = "view-source:" + $(this).data("url");
        // Firefox block extensionAPI.tabs.create in devtools
        extensionAPI.runtime.sendMessage({ action: "openURL", data: url, tabId: extensionAPI.devtools.inspectedWindow.tabId });
    });
}

// Modal events
function handleCloseModal() {
    $("#modal").css("display", "none");
}

function handleOutModal(event) {
    if (event.target == $("#modal")[0]) {
        $("#modal").css("display", "none");
    }
}

// Filter events — tag chips are multi-select
function handleFilterButton() {
    const filterData = $(this).data("filter");
    const tagCol = window.table.column(window.tableConfig.colIds.indexOf("tag"));

    if (filterData == "All") {
        window.activeTags.clear();
        $(".filter-button").removeClass("chip-active");
        $('.filter-button[data-filter="All"]').addClass("chip-active");
        tagCol.search("");
    } else {
        if (window.activeTags.has(filterData)) {
            window.activeTags.delete(filterData);
        } else {
            window.activeTags.add(filterData);
        }
        $(this).toggleClass("chip-active", window.activeTags.has(filterData));

        if (window.activeTags.size === 0) {
            $('.filter-button[data-filter="All"]').addClass("chip-active");
            tagCol.search("");
        } else {
            $('.filter-button[data-filter="All"]').removeClass("chip-active");
            const re = "^(" + [...window.activeTags].map(escapeRegExp).join("|") + ")$";
            tagCol.search(re, true, false);
        }
    }
    window.table.draw();
}

function handleAlertsFilter() {
    window.alertsOnly = !window.alertsOnly;
    $("#alerts-only").toggleClass("active", window.alertsOnly);
    const alertCol = window.table.column(window.tableConfig.colIds.indexOf("alert"));
    alertCol.search(window.alertsOnly ? "true" : "", false, false);
    window.table.draw();
}

function handleClearAllFilters() {
    window.activeTags.clear();
    window.alertsOnly = false;
    $(".filter-button").removeClass("chip-active");
    $('.filter-button[data-filter="All"]').addClass("chip-active");
    $("#alerts-only").removeClass("active");
    $("#filter-data").val("");
    $("#advanced-search")[0].reset();
    window.table.columns().every(function () { this.search(""); });
    window.table.search("");
    window.table.draw();
}

function handleFilterData() {
    const filterData = $(this).val();
    const colId = window.tableConfig.colIds.indexOf("data");

    window.table.column(colId).search(filterData, false, false);
    window.table.draw();
}

function handleAdvancedSearch(event) {
    event.preventDefault();
    const filters = this.filters.value.split(";");

    window.table.columns().every( function() {
        if (window.tableConfig.colIds[this.index()] !== "data")
            this.search('');
    });
    for (const f of filters) {
        var [ key, value ] = f.split("=");
        if (value && window.tableConfig.colIds.indexOf(key) !== -1 && key !== "data")
            window.table.column(window.tableConfig.colIds.indexOf(key)).search(value);
    }

    window.table.draw();
}

function handleFilterSpan() {
    var filterData = $(this).text() === window.table.search() ? "" : $(this).text();
    window.table.search(filterData);
    window.table.draw();
}

// Toolbar events
function handleConfigSwitch() {
    if (!window.panelHooksData) return;
    window.panelHooksData.selectedHook = parseInt($(this).val(), 10);
    extensionAPI.storage.local.set({ hooksData: window.panelHooksData });
}

function selectedContent() {
    if (!window.panelHooksData) return null;
    const s = window.panelHooksData.hooksSettings[window.panelHooksData.selectedHook];
    if (!s) return null;
    if (!s.content) s.content = {};
    return s.content;
}

function handleCanaryChange() {
    const content = selectedContent();
    if (!content) return;
    if (!content.globals) content.globals = {};
    content.globals.canary = $("#panel-canary").val();
    extensionAPI.storage.local.set({ hooksData: window.panelHooksData });
}

function handleCanaryCopy() {
    const val = $("#panel-canary").val();
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => {
        const btn = $("#canary-copy");
        const prev = btn.text();
        btn.text("✓");
        setTimeout(() => btn.text(prev), 900);
    }).catch(() => {});
}

function handleModeToggle() {
    const content = selectedContent();
    if (!content) return;
    const mode = $(this).data("mode");
    if (!content.config) content.config = {};
    if (!content.config["*"]) content.config["*"] = {};
    content.config["*"].match = mode === "hunt"
        ? ["exec:return new RegExp(domlogger.globals.canary)"]
        : ["exec:return /.*/"];
    $("#mode-recon").toggleClass("mode-active", mode === "recon");
    $("#mode-hunt").toggleClass("mode-active", mode === "hunt");
    extensionAPI.storage.local.set({ hooksData: window.panelHooksData });
}

// Legend
function handleToggleLegend() {
    const el = document.getElementById("legend");
    el.hidden = !el.hidden;
}

// Debug events
function handleStartDebug() {
    var debugCanary = $(this).data("debug");
    var debugHref = $(this).data("href");
    extensionAPI.runtime.sendMessage({
        action: "debugSink",
        tabId: extensionAPI.devtools.inspectedWindow.tabId,
        url: debugHref,
        canary: debugCanary
    })
}

function handleRedirection() {
    var debugHref = $(this).data("href").replaceAll("'", "\\'");
    extensionAPI.runtime.sendMessage({
        action: "debugSink",
        tabId: extensionAPI.devtools.inspectedWindow.tabId,
        url: debugHref,
        canary: false
    })
}

// Fullscreen events
function handleFullscreen() {
    if ($("#fullscreen").data("fullscreen") === "off") {
        $(".hide-fullscreen").css("display", "none");
        $("#fullscreen-svg").attr("xlink:href", "./img/angle-up.svg#angle-icon");
        $("#fullscreen").data("fullscreen", "on");
    } else {
        $(".hide-fullscreen").css("display", "block");
        $("#fullscreen-svg").attr("xlink:href", "./img/angle-down.svg#angle-icon");
        $("#fullscreen").data("fullscreen", "off");
    }
}

// Misc events
function handleRemoveRow() {
    window.table.row($(this).parents("tr")).remove();
    extensionAPI.runtime.sendMessage({ action: "removeRow", data: $(this).attr("data-dupKey") });
    window.table.draw();
    if (window.updateAlertsCount) window.updateAlertsCount();
    if (window.updateEmptyState) window.updateEmptyState();
}

// Buttons events
function handleImportClick() {
    $("#importFile").click();
}

function handleImport(e) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = function(e) {
        var data = {};
        try {
            data = JSON.parse(e.target.result);
        } catch {}

        // Sending data to background script to avoid duplicates
        for (var l of data) {
            if (l.date && l.href && l.tag && l.frame && l.sink && l.data && l.trace && l.debug) {
                l["import"] = true;
                extensionAPI.runtime.sendMessage({ data: l });
            }
        }
    }
    reader.readAsText(file);
}

function handleClear() {
    window.table.clear().draw();
    extensionAPI.runtime.sendMessage({ action: "clearStorage" });
    if (window.updateAlertsCount) window.updateAlertsCount();
    if (window.updateEmptyState) window.updateEmptyState();
}

function handleExport() {
    var data = window.table.rows().data().toArray();

    // Unsanitize data HTML before exporting (check background.js)
    for (let i=0; i<data.length; i++) {
        data[i].data = unsanitizeHtml(data[i].data);
    }

    data = JSON.stringify(data, null, 2);
    downloadData("export.json", data);
}

function handleSettingsNavigation() {
    extensionAPI.runtime.sendMessage({ action: "openSettings" });
}

export {
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
    handleStartDebug,
    handleRedirection,
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
}
