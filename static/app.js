/* ==========================================================================
   ArduPilot GPS Log Analyzer — Frontend Application
   Supports single-file and batch (multi-file) analysis.
   ========================================================================== */

// --- State ---
let allResults = [];       // Array of parsed results (one per file)
let activeFileIndex = -1;  // -1 = overview, 0+ = individual file
let isBatchMode = false;
let charts = {};
let batchCharts = {};
let leafletMap = null;
let batchMap = null;
let currentMapBounds = null;
let tablePage = 0;
const PAGE_SIZE = 100;
let filteredGPS = [];

// --- Chart.js Global Config ---
Chart.defaults.color = '#a1a1aa';
Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.08)';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
Chart.defaults.animation = { duration: 800, easing: 'easeOutQuart' };

const CHART_COLORS = {
    success: '#22c55e',
    successFill: 'rgba(34, 197, 94, 0.12)',
    info: '#38bdf8',
    infoFill: 'rgba(56, 189, 248, 0.12)',
    warning: '#f59e0b',
    warningFill: 'rgba(245, 158, 11, 0.12)',
    danger: '#ef4444',
    dangerFill: 'rgba(239, 68, 68, 0.12)',
    purple: '#a855f7',
    purpleFill: 'rgba(168, 85, 247, 0.12)',
};

// Distinct colors for multi-line batch comparison charts
const BATCH_LINE_COLORS = [
    '#06d6a0', '#118ab2', '#ffd166', '#ef476f', '#8338ec',
    '#73d2de', '#f4845f', '#a3cef1', '#e0aaff', '#90be6d',
    '#f9c74f', '#43aa8b', '#577590', '#f3722c', '#4cc9f0',
];

const FIX_COLORS = {
    0: '#ef476f',
    1: '#ef476f',
    2: '#ffd166',
    3: '#06d6a0',
    4: '#118ab2',
    5: '#ffd166',
    6: '#8338ec',
};

const FIX_LABELS = {
    0: 'No GPS',
    1: 'No Fix',
    2: '2D Fix',
    3: '3D Fix',
    4: 'DGPS',
    5: 'RTK Float',
    6: 'RTK Fixed',
};

// --- Chart zoom/pan plugin options ---
const ZOOM_PAN_OPTS = {
    zoom: {
        wheel: { enabled: true },
        pinch: { enabled: true },
        mode: 'x',
    },
    pan: {
        enabled: true,
        mode: 'x',
    },
};

// ======================================================================
// Upload Handling
// ======================================================================
const dropZone = document.getElementById('drop-zone');
const fileInputSingle = document.getElementById('file-input-single');
const fileInputBatch = document.getElementById('file-input-batch');

// Clicking the drop zone area (outside buttons) does nothing special
// The buttons have their own labels/inputs

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter((f) => {
        const ext = f.name.split('.').pop().toLowerCase();
        return ext === 'bin' || ext === 'log';
    });
    if (files.length === 0) return;
    if (files.length === 1) {
        uploadSingle(files[0]);
    } else {
        uploadBatch(files);
    }
});

fileInputSingle.addEventListener('change', () => {
    if (fileInputSingle.files.length > 0) {
        uploadSingle(fileInputSingle.files[0]);
    }
});

fileInputBatch.addEventListener('change', () => {
    const files = Array.from(fileInputBatch.files);
    if (files.length > 0) {
        if (files.length === 1) {
            uploadSingle(files[0]);
        } else {
            uploadBatch(files);
        }
    }
});

// --- Single File Upload ---
function uploadSingle(file) {
    isBatchMode = false;
    showSection('loading');
    document.getElementById('loading-text').textContent = `Parsing ${file.name}...`;
    document.getElementById('loading-subtext').textContent =
        `${(file.size / (1024 * 1024)).toFixed(1)} MB — Extracting GPS, GPA & UBX messages`;
    document.getElementById('loading-progress').style.display = 'none';

    const formData = new FormData();
    formData.append('logfile', file);

    fetch('/api/analyze', {
        method: 'POST',
        body: formData,
    })
        .then((res) => res.json())
        .then((data) => {
            if (data.error) {
                showError(data.error);
                return;
            }
            allResults = [data];
            activeFileIndex = 0;
            showSection('dashboard');
            renderFileTabs();
            renderSingleDashboard(data);
        })
        .catch((err) => {
            showError(err.message || 'Network error — is the server running?');
        });
}

// --- Batch Upload ---
function uploadBatch(files) {
    isBatchMode = true;
    showSection('loading');
    document.getElementById('loading-text').textContent = `Parsing ${files.length} flight logs...`;
    document.getElementById('loading-subtext').textContent = `Uploading and analyzing all files`;
    const progressEl = document.getElementById('loading-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressLabel = document.getElementById('progress-label');
    progressEl.style.display = '';
    progressFill.style.width = '0%';
    progressLabel.textContent = `0 / ${files.length}`;

    const formData = new FormData();
    files.forEach((f) => formData.append('logfiles', f));

    // Show indeterminate progress while uploading
    let totalSize = files.reduce((a, f) => a + f.size, 0);
    document.getElementById('loading-subtext').textContent =
        `${(totalSize / (1024 * 1024)).toFixed(1)} MB total — Uploading & parsing`;

    fetch('/api/analyze-batch', {
        method: 'POST',
        body: formData,
    })
        .then((res) => res.json())
        .then((data) => {
            if (data.error && !data.files) {
                showError(data.error);
                return;
            }
            allResults = data.files || [];
            if (allResults.length === 0) {
                showError('No logs could be parsed.');
                return;
            }
            // Sort by filename
            allResults.sort((a, b) => a.filename.localeCompare(b.filename));
            activeFileIndex = -1; // Start on overview
            progressFill.style.width = '100%';
            progressLabel.textContent = `${allResults.length} / ${files.length} parsed`;

            setTimeout(() => {
                showSection('dashboard');
                renderFileTabs();
                renderBatchOverview();
            }, 400);
        })
        .catch((err) => {
            showError(err.message || 'Network error — is the server running?');
        });
}

// ======================================================================
// Section Management
// ======================================================================
function showSection(name) {
    ['upload', 'loading', 'dashboard', 'error'].forEach((s) => {
        document.getElementById(`${s}-section`).style.display = s === name ? '' : 'none';
    });
    const newBtn = document.getElementById('btn-new-upload');
    const footer = document.getElementById('footer');
    if (name === 'dashboard') {
        newBtn.style.display = '';
        footer.style.display = '';
    } else {
        newBtn.style.display = 'none';
        footer.style.display = 'none';
    }
}

function showError(msg) {
    document.getElementById('error-message').textContent = msg;
    showSection('error');
}

function resetAll() {
    allResults = [];
    activeFileIndex = -1;
    isBatchMode = false;
    destroyCharts();
    destroyBatchCharts();
    if (leafletMap) {
        try { leafletMap.remove(); } catch (e) {}
        leafletMap = null;
    }
    if (batchMap) {
        try { batchMap.remove(); } catch (e) {}
        batchMap = null;
    }
    fileInputSingle.value = '';
    fileInputBatch.value = '';
    showSection('upload');
}

// ======================================================================
// File Tabs
// ======================================================================
function renderFileTabs() {
    const bar = document.getElementById('file-tabs-bar');
    const container = document.getElementById('file-tabs');

    if (allResults.length <= 1 && !isBatchMode) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = '';
    container.innerHTML = '';

    // Overview tab (batch mode only)
    if (isBatchMode) {
        const overviewTab = document.createElement('button');
        overviewTab.className = `file-tab tab-overview ${activeFileIndex === -1 ? 'active' : ''}`;
        overviewTab.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
            Overview (${allResults.length} logs)
        `;
        overviewTab.onclick = () => switchToFile(-1);
        container.appendChild(overviewTab);
    }

    // Individual file tabs
    allResults.forEach((r, i) => {
        const tab = document.createElement('button');
        const statusClass = getStatusClass(r.summary);
        tab.className = `file-tab ${activeFileIndex === i ? 'active' : ''}`;
        tab.innerHTML = `
            <span class="tab-status ${statusClass}"></span>
            ${truncateFilename(r.filename)}
        `;
        tab.onclick = () => switchToFile(i);
        container.appendChild(tab);
    });
}

function getStatusClass(summary) {
    if (!summary) return 'tab-status-bad';
    if (summary.pct_3d_or_better >= 95 && summary.hdop_avg <= 2) return 'tab-status-good';
    if (summary.pct_3d_or_better >= 70) return 'tab-status-warn';
    return 'tab-status-bad';
}

function truncateFilename(name) {
    if (name.length <= 25) return name;
    return name.substring(0, 11) + '…' + name.substring(name.length - 11);
}

function switchToFile(index) {
    activeFileIndex = index;
    renderFileTabs();

    if (index === -1) {
        renderBatchOverview();
    } else {
        hideBatchOverview();
        renderSingleDashboard(allResults[index]);
    }
}

// ======================================================================
// Single File Dashboard
// ======================================================================
function renderSingleDashboard(data) {
    destroyCharts();
    document.getElementById('single-dashboard').style.display = '';

    // File info
    document.getElementById('file-name').textContent = data.filename || '—';
    document.getElementById('file-samples').textContent = `${data.total_gps_msgs.toLocaleString()} GPS samples`;
    document.getElementById('file-duration').textContent = `${data.summary.time_span_min || 0} min`;
    document.getElementById('file-msgs').textContent = data.msg_types_found.join(', ');

    filteredGPS = data.gps;
    tablePage = 0;

    renderVerdictBanner(data.summary.verdict);
    renderSummaryCards(data.summary);
    renderPrecisionAnalysis(data.summary);
    renderCharts(data);

    // Render map AFTER the section is visible so Leaflet can measure the container
    requestAnimationFrame(() => {
        renderMap(data.gps, data.summary);
    });
}

// ======================================================================
// Overall GPS Quality Verdict Banner
// ======================================================================
function renderVerdictBanner(verdict) {
    const banner = document.getElementById('verdict-banner');
    if (!banner) return;
    if (!verdict) {
        banner.style.display = 'none';
        return;
    }
    banner.style.display = 'flex';

    const rating = (verdict.rating || 'GOOD').toUpperCase();
    const score = verdict.score !== undefined ? verdict.score : 100;
    const cls = rating === 'GOOD' ? 'verdict-good' : rating === 'ACCEPTABLE' ? 'verdict-acceptable' : 'verdict-bad';

    banner.className = `verdict-banner ${cls}`;

    // Icon
    const iconEl = document.getElementById('verdict-icon');
    if (rating === 'GOOD') {
        iconEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (rating === 'ACCEPTABLE') {
        iconEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
        iconEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    }

    // Tag and Score
    document.getElementById('verdict-tag').textContent = rating === 'GOOD' ? 'GOOD' : rating === 'ACCEPTABLE' ? 'ACCEPTABLE / WARNING' : 'POOR / BAD';
    document.getElementById('verdict-score').textContent = `Health Score: ${score}/100`;

    // Sentence
    const sentenceEl = document.getElementById('verdict-sentence');
    sentenceEl.textContent = verdict.sentence || `Overall GPS Quality is ${rating}.`;

    // Chips for positives and issues
    const chipsEl = document.getElementById('verdict-chips');
    if (chipsEl) {
        chipsEl.innerHTML = '';
        (verdict.positives || []).forEach(p => {
            const chip = document.createElement('span');
            chip.className = 'verdict-chip verdict-chip-pos';
            chip.innerHTML = `✓ ${p}`;
            chipsEl.appendChild(chip);
        });
        (verdict.issues || []).forEach(iss => {
            const chip = document.createElement('span');
            chip.className = 'verdict-chip verdict-chip-neg';
            chip.innerHTML = `⚠ ${iss}`;
            chipsEl.appendChild(chip);
        });
    }
}

// --- Summary Cards ---
function renderSummaryCards(s) {
    const container = document.getElementById('summary-cards');
    container.innerHTML = '';

    const cards = [
        {
            label: 'Best Fix Type',
            value: s.best_fix || '—',
            unit: '',
            sub: `${s.pct_3d_or_better}% ≥ 3D`,
            cls: 'card-green',
        },
        {
            label: 'Satellites (avg)',
            value: s.sats_avg,
            unit: 'sats',
            sub: `Min ${s.sats_min} · Max ${s.sats_max}`,
            cls: 'card-blue',
        },
        {
            label: 'HDOP (avg)',
            value: s.hdop_avg,
            unit: '',
            sub: `Min ${s.hdop_min} · Max ${s.hdop_max}`,
            cls: s.hdop_avg <= 1.5 ? 'card-green' : s.hdop_avg <= 3 ? 'card-yellow' : 'card-red',
        },
        {
            label: 'Flight Duration',
            value: s.time_span_min,
            unit: 'min',
            sub: `${s.total_samples.toLocaleString()} samples`,
            cls: 'card-purple',
        },
        {
            label: 'Max Speed',
            value: s.speed_max,
            unit: 'm/s',
            sub: `Avg ${s.speed_avg} m/s`,
            cls: 'card-blue',
        },
        {
            label: 'Altitude Range',
            value: `${s.alt_min} — ${s.alt_max}`,
            unit: 'm',
            sub: `${(s.alt_max - s.alt_min).toFixed(1)}m span`,
            cls: 'card-yellow',
        },
    ];

    if (s.distance_km !== undefined) {
        const distVal = s.distance_km >= 1 ? `${s.distance_km}` : `${s.distance_m}`;
        const distUnit = s.distance_km >= 1 ? 'km' : 'm';
        cards.splice(4, 0, {
            label: 'Track Distance',
            value: distVal,
            unit: distUnit,
            sub: `${s.valid_gps_points || 0} valid track pts`,
            cls: 'card-green',
        });
    }

    if (s.hacc_avg !== undefined) {
        cards.push({
            label: 'H-Accuracy (avg)',
            value: s.hacc_avg,
            unit: 'm',
            sub: `Min ${s.hacc_min} · Max ${s.hacc_max}`,
            cls: s.hacc_avg <= 2 ? 'card-green' : s.hacc_avg <= 5 ? 'card-yellow' : 'card-red',
        });
    }
    if (s.vacc_avg !== undefined) {
        cards.push({
            label: 'V-Accuracy (avg)',
            value: s.vacc_avg,
            unit: 'm',
            sub: `Min ${s.vacc_min} · Max ${s.vacc_max}`,
            cls: s.vacc_avg <= 3 ? 'card-green' : s.vacc_avg <= 8 ? 'card-yellow' : 'card-red',
        });
    }
    if (s.vdop_avg !== undefined) {
        cards.push({
            label: 'VDOP (avg)',
            value: s.vdop_avg,
            unit: '',
            sub: `Min ${s.vdop_min} · Max ${s.vdop_max}`,
            cls: s.vdop_avg <= 2 ? 'card-green' : s.vdop_avg <= 4 ? 'card-yellow' : 'card-red',
        });
    }
    if (s.update_rate_avg_hz !== undefined) {
        cards.push({
            label: 'Update Rate',
            value: s.update_rate_avg_hz,
            unit: 'Hz',
            sub: `Avg interval ${s.update_rate_avg_ms}ms`,
            cls: 'card-purple',
        });
    }

    cards.forEach((c) => {
        const el = document.createElement('div');
        el.className = `stat-card ${c.cls} animate-in`;
        el.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}<span class="stat-unit">${c.unit}</span></div>
            <div class="stat-sub">${c.sub}</div>
        `;
        container.appendChild(el);
    });
}

// ======================================================================
// Chart Helpers
// ======================================================================
function downsample(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const step = Math.ceil(arr.length / maxPoints);
    const result = [];
    for (let i = 0; i < arr.length; i += step) {
        result.push(arr[i]);
    }
    if (result[result.length - 1] !== arr[arr.length - 1]) {
        result.push(arr[arr.length - 1]);
    }
    return result;
}

function makeTimeLabels(data) {
    return data.map((d) => d.time_s);
}

function createLineChart(canvasId, labels, datasets, yTitle, extraOpts, chartStore) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    const store = chartStore || charts;

    const config = {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: datasets.length > 1 },
                zoom: ZOOM_PAN_OPTS,
                tooltip: {
                    backgroundColor: 'rgba(18, 18, 22, 0.96)',
                    titleColor: '#f4f4f5',
                    bodyColor: '#a1a1aa',
                    borderColor: 'rgba(255, 255, 255, 0.12)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 10,
                },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Time (s)', color: '#71717a' },
                    ticks: { maxTicksLimit: 15, color: '#71717a' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                },
                y: {
                    title: { display: true, text: yTitle, color: '#71717a' },
                    ticks: { color: '#71717a' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ...(extraOpts?.yConfig || {}),
                },
            },
            elements: {
                point: { radius: 0, hoverRadius: 4 },
                line: { tension: 0.3, borderWidth: 2 },
            },
        },
    };

    if (extraOpts?.stepped) {
        config.options.elements.line.tension = 0;
        config.options.elements.line.stepped = true;
    }

    store[canvasId] = new Chart(ctx, config);
    return store[canvasId];
}

function destroyCharts() {
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
    if (leafletMap) {
        try { leafletMap.remove(); } catch (e) {}
        leafletMap = null;
    }
}

function destroyBatchCharts() {
    Object.values(batchCharts).forEach((c) => c.destroy());
    batchCharts = {};
    if (batchMap) {
        try { batchMap.remove(); } catch (e) {}
        batchMap = null;
    }
}

// ======================================================================
// Render All Charts (Single File)
// ======================================================================
function renderCharts(data) {
    const gps = downsample(data.gps, 2000);
    const gpa = downsample(data.gpa, 2000);

    // 1. Fix Quality
    const fixLabels = makeTimeLabels(gps);

    createLineChart(
        'chart-fix',
        fixLabels,
        [
            {
                label: 'Fix Status',
                data: gps.map((g) => g.status),
                borderColor: CHART_COLORS.success,
                backgroundColor: CHART_COLORS.successFill,
                fill: true,
                segment: {
                    borderColor: (ctx) => FIX_COLORS[ctx.p1.parsed.y] || CHART_COLORS.success,
                },
            },
        ],
        'Fix Type',
        {
            stepped: true,
            yConfig: {
                min: 0,
                max: 6,
                ticks: {
                    stepSize: 1,
                    callback: (v) => FIX_LABELS[v] || v,
                },
            },
        }
    );

    // 2. Satellite Count
    createLineChart(
        'chart-sats',
        fixLabels,
        [
            {
                label: 'Satellites',
                data: gps.map((g) => g.num_sats),
                borderColor: CHART_COLORS.info,
                backgroundColor: CHART_COLORS.infoFill,
                fill: true,
            },
        ],
        'Satellite Count'
    );

    // 3. HDOP
    createLineChart(
        'chart-hdop',
        fixLabels,
        [
            {
                label: 'HDOP',
                data: gps.map((g) => g.hdop),
                borderColor: CHART_COLORS.warning,
                backgroundColor: CHART_COLORS.warningFill,
                fill: true,
            },
        ],
        'HDOP'
    );

    // 4. VDOP (from GPA)
    if (gpa.length > 0) {
        createLineChart(
            'chart-vdop',
            makeTimeLabels(gpa),
            [
                {
                    label: 'VDOP',
                    data: gpa.map((g) => g.vdop),
                    borderColor: CHART_COLORS.purple,
                    backgroundColor: CHART_COLORS.purpleFill,
                    fill: true,
                },
            ],
            'VDOP'
        );

        // 5. HAcc
        createLineChart(
            'chart-hacc',
            makeTimeLabels(gpa),
            [
                {
                    label: 'HAcc (m)',
                    data: gpa.map((g) => g.hacc),
                    borderColor: CHART_COLORS.success,
                    backgroundColor: CHART_COLORS.successFill,
                    fill: true,
                },
            ],
            'Horizontal Accuracy (m)'
        );

        // 6. VAcc
        createLineChart(
            'chart-vacc',
            makeTimeLabels(gpa),
            [
                {
                    label: 'VAcc (m)',
                    data: gpa.map((g) => g.vacc),
                    borderColor: CHART_COLORS.danger,
                    backgroundColor: CHART_COLORS.dangerFill,
                    fill: true,
                },
            ],
            'Vertical Accuracy (m)'
        );

        // Update interval (Delta)
        const deltasFiltered = gpa.filter((g) => g.delta_ms > 0);
        if (deltasFiltered.length > 0) {
            createLineChart(
                'chart-delta',
                makeTimeLabels(downsample(deltasFiltered, 2000)),
                [
                    {
                        label: 'Update Interval (ms)',
                        data: downsample(deltasFiltered, 2000).map((g) => g.delta_ms),
                        borderColor: CHART_COLORS.info,
                        backgroundColor: CHART_COLORS.infoFill,
                        fill: true,
                    },
                ],
                'Interval (ms)'
            );
        }
    }

    // 7. Speed
    createLineChart(
        'chart-speed',
        fixLabels,
        [
            {
                label: 'Ground Speed (m/s)',
                data: gps.map((g) => g.speed),
                borderColor: CHART_COLORS.success,
                backgroundColor: CHART_COLORS.successFill,
                fill: true,
            },
        ],
        'Speed (m/s)'
    );

    // 8. Altitude
    createLineChart(
        'chart-alt',
        fixLabels,
        [
            {
                label: 'Altitude MSL (m)',
                data: gps.map((g) => g.alt),
                borderColor: CHART_COLORS.info,
                backgroundColor: CHART_COLORS.infoFill,
                fill: true,
            },
        ],
        'Altitude (m)'
    );

    // 9. Fix Distribution Pie
    if (data.summary.fix_distribution) {
        const fixDist = data.summary.fix_distribution;
        const pieLabels = Object.keys(fixDist);
        const pieData = Object.values(fixDist);
        const pieColors = pieLabels.map((label) => {
            const status = Object.entries(FIX_LABELS).find(([k, v]) => v === label);
            return status ? FIX_COLORS[parseInt(status[0])] : '#5a6785';
        });

        const ctx = document.getElementById('chart-fix-pie');
        charts['chart-fix-pie'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: pieLabels,
                datasets: [
                    {
                        data: pieData,
                        backgroundColor: pieColors,
                        borderColor: '#111827',
                        borderWidth: 2,
                        hoverOffset: 8,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true, pointStyleWidth: 10 },
                    },
                    tooltip: {
                        backgroundColor: 'rgba(18, 18, 22, 0.96)',
                        titleColor: '#f4f4f5',
                        bodyColor: '#a1a1aa',
                        borderColor: 'rgba(255, 255, 255, 0.12)',
                        borderWidth: 1,
                        cornerRadius: 8,
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                                return `${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
                            },
                        },
                    },
                },
            },
        });
    }

    // 10. UBX Jamming / Noise
    if (data.ubx1 && data.ubx1.length > 0) {
        document.getElementById('ubx-card').style.display = '';
        const ubxDown = downsample(data.ubx1, 2000);
        createLineChart(
            'chart-ubx',
            makeTimeLabels(ubxDown),
            [
                {
                    label: 'Noise/ms',
                    data: ubxDown.map((u) => u.noise_per_ms),
                    borderColor: CHART_COLORS.warning,
                    backgroundColor: CHART_COLORS.warningFill,
                    fill: true,
                    yAxisID: 'y',
                },
                {
                    label: 'Jamming Ind.',
                    data: ubxDown.map((u) => u.jam_ind),
                    borderColor: CHART_COLORS.danger,
                    backgroundColor: CHART_COLORS.dangerFill,
                    fill: true,
                    yAxisID: 'y1',
                },
            ],
            'Noise / ms'
        );
        if (charts['chart-ubx']) {
            charts['chart-ubx'].options.scales.y1 = {
                type: 'linear',
                position: 'right',
                title: { display: true, text: 'Jamming Indicator', color: '#5a6785' },
                ticks: { color: '#5a6785' },
                grid: { drawOnChartArea: false },
            };
            charts['chart-ubx'].update();
        }
    } else {
        document.getElementById('ubx-card').style.display = 'none';
    }
}

// ======================================================================
// Map — Fixed: render AFTER dashboard is visible, invalidateSize
// ======================================================================
// ======================================================================
// Flight Path Map (Single Log)
// ======================================================================
function renderMap(gps, summary) {
    const mapEl = document.getElementById('map');
    if (!mapEl) return;

    // Clean up previous map
    if (leafletMap) {
        try {
            leafletMap.remove();
        } catch (e) {
            console.warn('Error removing old map:', e);
        }
        leafletMap = null;
    }

    mapEl.innerHTML = '';

    // Filter valid positions (lat/lng not zero and within valid range)
    const validPoints = (gps || []).filter(
        (g) => Math.abs(g.lat) > 0.0001 && Math.abs(g.lng) > 0.0001 && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180
    );

    const statsOverlay = document.getElementById('map-stats-overlay');
    const recenterBtn = document.getElementById('btn-recenter-map');

    if (validPoints.length === 0) {
        if (statsOverlay) statsOverlay.style.display = 'none';
        if (recenterBtn) recenterBtn.style.display = 'none';
        mapEl.innerHTML = `
            <div class="map-empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5a6785" stroke-width="1.5"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                <h4>No GPS Coordinates Logged</h4>
                <p>This log contains GPS messages, but no 2D/3D fix coordinates were acquired (e.g. indoor bench test).</p>
            </div>
        `;
        return;
    }

    if (statsOverlay) statsOverlay.style.display = 'flex';
    if (recenterBtn) recenterBtn.style.display = 'inline-flex';

    // Calculate bounds & center
    const lats = validPoints.map((p) => p.lat);
    const lngs = validPoints.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    const latSpan = maxLat - minLat;
    const lngSpan = maxLng - minLng;
    const isStationary = latSpan < 0.0001 && lngSpan < 0.0001;

    // Base Layers
    const satLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
            attribution: 'Tiles &copy; Esri &mdash; Maxar, Earthstar Geographics',
            maxZoom: 19,
        }
    );
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
    });
    const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OSM &copy; CARTO',
        maxZoom: 20,
        subdomains: 'abcd',
    });

    // Create the map ALWAYS with center and zoom so tileLayer loads immediately
    leafletMap = L.map(mapEl, {
        center: [centerLat, centerLng],
        zoom: isStationary ? 17 : 16,
        layers: [satLayer], // Default to satellite imagery for drone flight path inspection
        zoomControl: true,
        attributionControl: true,
    });

    // Layer switch control
    L.control.layers(
        {
            '🛰️ Satellite (Esri)': satLayer,
            '🗺️ OpenStreetMap': osmLayer,
            '🌙 Dark Canvas': darkLayer,
        },
        null,
        { position: 'topright' }
    ).addTo(leafletMap);

    // Render path & markers
    if (isStationary) {
        L.circleMarker([centerLat, centerLng], {
            radius: 12,
            fillColor: '#ffd166',
            color: '#ffffff',
            weight: 3,
            fillOpacity: 0.9,
        })
            .bindPopup(
                `
                <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                    <strong style="color:#d97706;">📍 Stationary Position</strong><br>
                    <b>Coordinates:</b> ${centerLat.toFixed(6)}, ${centerLng.toFixed(6)}<br>
                    <b>Alt:</b> ${validPoints[0].alt} m<br>
                    <b>Fix:</b> ${validPoints[0].status_label} (${validPoints[0].num_sats} sats)<br>
                    <span style="color:#64748b;">(No flight movement recorded — bench or hover test)</span>
                </div>
            `
            )
            .addTo(leafletMap)
            .openPopup();

        currentMapBounds = L.latLngBounds([centerLat - 0.001, centerLng - 0.001], [centerLat + 0.001, centerLng + 0.001]);
    } else {
        // High-performance smooth polyline rendering
        const dsPoints = downsample(validPoints, 3500);

        // Backdrop line for contrast against satellite or dark tiles
        const fullCoords = dsPoints.map((p) => [p.lat, p.lng]);
        L.polyline(fullCoords, {
            color: '#000000',
            weight: 6,
            opacity: 0.55,
            lineCap: 'round',
            lineJoin: 'round',
        }).addTo(leafletMap);

        // Group consecutive points by status into polyline segments
        let currentStatus = dsPoints[0].status;
        let segment = [[dsPoints[0].lat, dsPoints[0].lng]];

        for (let i = 1; i < dsPoints.length; i++) {
            const pt = dsPoints[i];
            if (pt.status === currentStatus) {
                segment.push([pt.lat, pt.lng]);
            } else {
                segment.push([pt.lat, pt.lng]);
                L.polyline(segment, {
                    color: FIX_COLORS[currentStatus] || '#06d6a0',
                    weight: 3.5,
                    opacity: 0.95,
                    lineCap: 'round',
                    lineJoin: 'round',
                }).addTo(leafletMap);
                currentStatus = pt.status;
                segment = [[pt.lat, pt.lng]];
            }
        }
        if (segment.length > 1) {
            L.polyline(segment, {
                color: FIX_COLORS[currentStatus] || '#06d6a0',
                weight: 3.5,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round',
            }).addTo(leafletMap);
        }

        // Start marker (green)
        const first = validPoints[0];
        const startAlt = summary?.start_alt !== undefined ? summary.start_alt : first.alt;
        L.circleMarker([first.lat, first.lng], {
            radius: 8,
            fillColor: '#06d6a0',
            color: '#ffffff',
            weight: 2.5,
            fillOpacity: 1,
        })
            .bindPopup(
                `
                <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                    <strong style="color:#059669;">▶ Takeoff / Start Point</strong><br>
                    <b>Time:</b> ${first.time_s}s ${first.datetime ? '(' + first.datetime.split('T')[1].split('+')[0] + ' UTC)' : ''}<br>
                    <b>Takeoff Alt:</b> ${startAlt} m<br>
                    <b>Speed:</b> ${first.speed} m/s · <b>Sats:</b> ${first.num_sats} · <b>HDOP:</b> ${first.hdop}<br>
                    <b>Fix:</b> ${first.status_label}<br>
                    <b>Coords:</b> ${first.lat.toFixed(7)}, ${first.lng.toFixed(7)}
                </div>
            `
            )
            .addTo(leafletMap);

        // End marker (red)
        const last = validPoints[validPoints.length - 1];
        const endAlt = summary?.end_alt !== undefined ? summary.end_alt : last.alt;
        const altDiffStr = summary?.alt_diff !== undefined ? `${summary.alt_diff >= 0 ? '+' : ''}${summary.alt_diff} m (${summary.alt_diff_cm} cm)` : '—';
        const landingDistStr = summary?.takeoff_to_landing_dist_m !== undefined ? (summary.takeoff_to_landing_dist_m < 1 ? `${summary.takeoff_to_landing_dist_cm} cm` : `${summary.takeoff_to_landing_dist_m} m`) : '—';

        L.circleMarker([last.lat, last.lng], {
            radius: 8,
            fillColor: '#ef476f',
            color: '#ffffff',
            weight: 2.5,
            fillOpacity: 1,
        })
            .bindPopup(
                `
                <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                    <strong style="color:#dc2626;">■ Landing / End Point</strong><br>
                    <b>Time:</b> ${last.time_s}s ${last.datetime ? '(' + last.datetime.split('T')[1].split('+')[0] + ' UTC)' : ''}<br>
                    <b>Landing Alt:</b> ${endAlt} m<br>
                    <b>Alt Drift (ΔAlt):</b> ${altDiffStr}<br>
                    <b>Displacement from Takeoff:</b> ${landingDistStr}<br>
                    <b>Speed:</b> ${last.speed} m/s · <b>Sats:</b> ${last.num_sats} · <b>HDOP:</b> ${last.hdop}<br>
                    <b>Fix:</b> ${last.status_label}<br>
                    <b>Coords:</b> ${last.lat.toFixed(7)}, ${last.lng.toFixed(7)}
                </div>
            `
            )
            .addTo(leafletMap);

        // Draw Takeoff-to-Landing Vector Line
        if (summary && summary.takeoff_to_landing_dist_m !== undefined) {
            const vectorLine = L.polyline(
                [[first.lat, first.lng], [last.lat, last.lng]],
                {
                    color: '#ffd166',
                    weight: 2.5,
                    dashArray: '5, 8',
                    opacity: 0.9,
                }
            ).addTo(leafletMap);

            vectorLine.bindPopup(
                `
                <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                    <strong style="color:#b45309;">📏 Takeoff ➔ Landing Vector</strong><br>
                    <b>Horizontal Distance:</b> ${landingDistStr}<br>
                    <b>Altitude Difference:</b> ${altDiffStr}<br>
                    <b>3D Spatial Displacement:</b> ${summary.takeoff_to_landing_3d_m} m
                </div>
            `
            );
        }

        // Add interactive sample point clicks along the path
        const sampleStep = Math.max(1, Math.floor(validPoints.length / 25));
        for (let i = sampleStep; i < validPoints.length - 1; i += sampleStep) {
            const p = validPoints[i];
            L.circleMarker([p.lat, p.lng], {
                radius: 4,
                fillColor: FIX_COLORS[p.status] || '#118ab2',
                color: '#ffffff',
                weight: 1,
                fillOpacity: 0.8,
            })
                .bindPopup(
                    `
                    <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                        <strong style="color:#2563eb;">Waypoint @ ${p.time_s}s</strong><br>
                        <b>Alt:</b> ${p.alt} m · <b>Speed:</b> ${p.speed} m/s (${(p.speed * 3.6).toFixed(1)} km/h)<br>
                        <b>Sats:</b> ${p.num_sats} · <b>HDOP:</b> ${p.hdop}<br>
                        <b>Fix:</b> ${p.status_label}<br>
                        <b>Coords:</b> ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}
                    </div>
                `
                )
                .addTo(leafletMap);
        }

        currentMapBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
        leafletMap.fitBounds(currentMapBounds, { padding: [45, 45], maxZoom: 18 });
    }

    // Update floating stats badge
    if (statsOverlay && summary) {
        const distStr = summary.distance_km >= 1 ? `${summary.distance_km} km` : `${summary.distance_m || 0} m`;
        statsOverlay.innerHTML = `
            <div class="stat-pill"><span class="stat-pill-label">Distance</span> <span class="stat-pill-val">${distStr}</span></div>
            <div class="stat-pill"><span class="stat-pill-label">Duration</span> <span class="stat-pill-val">${summary.time_span_min}m</span></div>
            <div class="stat-pill"><span class="stat-pill-label">Max Alt</span> <span class="stat-pill-val">${summary.alt_max}m</span></div>
            <div class="stat-pill"><span class="stat-pill-label">Max Speed</span> <span class="stat-pill-val">${summary.speed_max}m/s</span></div>
            ${isStationary ? '<div class="stat-pill stat-pill-warn">Stationary / Bench</div>' : ''}
        `;
    }

    // Invalidate size in stages to ensure complete rendering regardless of CSS transitions
    [100, 300, 600, 1000].forEach((delay) => {
        setTimeout(() => {
            if (leafletMap) {
                leafletMap.invalidateSize({ animate: false });
                if (currentMapBounds && !isStationary) {
                    leafletMap.fitBounds(currentMapBounds, { padding: [45, 45], maxZoom: 18 });
                }
            }
        }, delay);
    });
}

function recenterMap() {
    if (leafletMap && currentMapBounds) {
        leafletMap.invalidateSize();
        leafletMap.fitBounds(currentMapBounds, { padding: [45, 45], maxZoom: 18 });
    }
}

// ======================================================================
// Batch Overview
// ======================================================================
function renderBatchOverview() {
    destroyCharts();
    destroyBatchCharts();

    document.getElementById('single-dashboard').style.display = 'none';
    document.getElementById('batch-overview').style.display = '';

    renderBatchTable();
    renderBatchComparisonCharts();

    // Render batch combined map
    requestAnimationFrame(() => {
        renderBatchMap();
    });
}

function hideBatchOverview() {
    document.getElementById('batch-overview').style.display = 'none';
    document.getElementById('single-dashboard').style.display = '';
}

function renderBatchTable() {
    const tbody = document.getElementById('batch-table-body');
    tbody.innerHTML = allResults
        .map((r, i) => {
            const s = r.summary;
            const statusClass = getStatusClass(s);
            const distStr = s.distance_km >= 1 ? `${s.distance_km} km` : s.distance_m ? `${s.distance_m} m` : '—';
            const v = s.verdict || { rating: 'GOOD', score: 100, sentence: '' };
            const vRating = v.rating || 'GOOD';
            const vClass = vRating.toLowerCase();
            const altDiffStr = s.alt_diff !== undefined ? `${s.alt_diff >= 0 ? '+' : ''}${s.alt_diff} m` : '—';
            const landingDistStr = s.takeoff_to_landing_dist_m !== undefined 
                ? (s.takeoff_to_landing_dist_m < 1 ? `${s.takeoff_to_landing_dist_cm} cm` : `${s.takeoff_to_landing_dist_m} m`) 
                : '—';
            return `
                <tr style="cursor:pointer;" onclick="switchToFile(${i})">
                    <td>
                        <span class="tab-status ${statusClass}" style="display:inline-block;margin-right:6px;"></span>
                        ${r.filename}
                    </td>
                    <td>
                        <span class="verdict-tag-sm verdict-tag-${vClass}" title="${v.sentence || ''}">${vRating}</span>
                    </td>
                    <td>${s.time_span_min} min</td>
                    <td><b>${distStr}</b></td>
                    <td>${s.start_alt !== undefined ? s.start_alt + ' m' : '—'}</td>
                    <td>${s.end_alt !== undefined ? s.end_alt + ' m' : '—'}</td>
                    <td><b style="color:${Math.abs(s.alt_diff || 0) <= 0.5 ? '#06d6a0' : Math.abs(s.alt_diff || 0) <= 1.5 ? '#ffd166' : '#ef476f'}">${altDiffStr}</b></td>
                    <td><span class="precision-badge-pill ${s.takeoff_to_landing_dist_m < 1 ? 'precision-badge-submeter' : 'precision-badge-good'}" style="font-size:0.7rem;padding:1px 6px;">${landingDistStr}</span></td>
                    <td>${s.total_samples.toLocaleString()}</td>
                    <td><span class="fix-badge fix-badge-${Object.entries(FIX_LABELS).find(([k,v]) => v === s.best_fix)?.[0] || 3}">${s.best_fix}</span></td>
                    <td>${s.pct_3d_or_better}%</td>
                    <td>${s.sats_avg}</td>
                    <td>${s.hdop_avg}</td>
                    <td>${s.hacc_avg !== undefined ? s.hacc_avg + 'm' : '—'}</td>
                    <td>${s.speed_max} m/s</td>
                </tr>
            `;
        })
        .join('');
}

function renderBatchMap() {
    const mapEl = document.getElementById('batch-map');
    const legendEl = document.getElementById('batch-map-legend');
    if (!mapEl) return;

    if (batchMap) {
        try {
            batchMap.remove();
        } catch (e) {
            console.warn('Error removing old batch map:', e);
        }
        batchMap = null;
    }
    mapEl.innerHTML = '';
    if (legendEl) legendEl.innerHTML = '';

    // Collect all valid points from all results
    const flightTracks = [];
    allResults.forEach((r, idx) => {
        const valid = (r.gps || []).filter(
            (g) => Math.abs(g.lat) > 0.0001 && Math.abs(g.lng) > 0.0001 && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180
        );
        if (valid.length > 0) {
            flightTracks.push({
                index: idx,
                filename: r.filename,
                color: BATCH_LINE_COLORS[idx % BATCH_LINE_COLORS.length],
                summary: r.summary,
                points: valid,
            });
        }
    });

    if (flightTracks.length === 0) {
        mapEl.innerHTML = '<div class="map-empty-state"><p>No GPS coordinates logged across batch files</p></div>';
        return;
    }

    // Determine global bounds
    let allLats = [];
    let allLngs = [];
    flightTracks.forEach((ft) => {
        ft.points.forEach((p) => {
            allLats.push(p.lat);
            allLngs.push(p.lng);
        });
    });

    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const minLng = Math.min(...allLngs);
    const maxLng = Math.max(...allLngs);
    const center = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];

    const satLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
            attribution: 'Tiles &copy; Esri',
            maxZoom: 19,
        }
    );
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
    });
    const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        maxZoom: 20,
        subdomains: 'abcd',
    });

    batchMap = L.map(mapEl, {
        center: center,
        zoom: 14,
        layers: [satLayer],
        zoomControl: true,
    });

    L.control.layers(
        {
            '🛰️ Satellite': satLayer,
            '🗺️ OpenStreetMap': osmLayer,
            '🌙 Dark Mode': darkLayer,
        },
        null,
        { position: 'topright' }
    ).addTo(batchMap);

    // Plot each flight
    flightTracks.forEach((ft) => {
        const ds = downsample(ft.points, 1500);
        const coords = ds.map((p) => [p.lat, p.lng]);

        // Backdrop
        L.polyline(coords, { color: '#000000', weight: 5, opacity: 0.55 }).addTo(batchMap);

        // Flight line
        const poly = L.polyline(coords, {
            color: ft.color,
            weight: 3.5,
            opacity: 0.95,
        }).addTo(batchMap);

        const distStr = ft.summary.distance_km >= 1 ? `${ft.summary.distance_km} km` : `${ft.summary.distance_m || 0} m`;
        poly.bindPopup(
            `
            <div style="font-family:sans-serif;font-size:12px;color:#1e293b;">
                <strong style="color:${ft.color};">${ft.filename}</strong><br>
                <b>Duration:</b> ${ft.summary.time_span_min} min<br>
                <b>Distance:</b> ${distStr}<br>
                <b>Max Alt:</b> ${ft.summary.alt_max} m · <b>Speed:</b> ${ft.summary.speed_max} m/s<br>
                <b>Avg Sats:</b> ${ft.summary.sats_avg} · <b>Fix:</b> ${ft.summary.best_fix}<br>
                <div style="margin-top:8px;">
                    <button class="btn btn-primary btn-sm" onclick="switchToFile(${ft.index})" style="padding:3px 10px;font-size:11px;cursor:pointer;">Open Log Analysis →</button>
                </div>
            </div>
        `
        );

        // Start point dot
        L.circleMarker([coords[0][0], coords[0][1]], {
            radius: 6,
            fillColor: ft.color,
            color: '#ffffff',
            weight: 2,
            fillOpacity: 1,
        })
            .bindPopup(`<b>${ft.filename}</b> (Start Point)`)
            .addTo(batchMap);

        // Add legend chip
        if (legendEl) {
            const chip = document.createElement('div');
            chip.className = 'batch-legend-chip';
            chip.innerHTML = `<span class="legend-dot" style="background:${ft.color};"></span> ${truncateFilename(ft.filename)} (${distStr})`;
            chip.onclick = () => switchToFile(ft.index);
            legendEl.appendChild(chip);
        }
    });

    const bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
    batchMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });

    [150, 400, 800].forEach((d) => {
        setTimeout(() => {
            if (batchMap) {
                batchMap.invalidateSize({ animate: false });
                batchMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
            }
        }, d);
    });
}

function renderBatchComparisonCharts() {
    // Satellite count comparison (bar chart)
    const ctx1 = document.getElementById('chart-batch-sats');
    const labels = allResults.map((r) => truncateFilename(r.filename));
    batchCharts['chart-batch-sats'] = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Avg Sats',
                    data: allResults.map((r) => r.summary.sats_avg),
                    backgroundColor: allResults.map((_, i) => BATCH_LINE_COLORS[i % BATCH_LINE_COLORS.length] + '99'),
                    borderColor: allResults.map((_, i) => BATCH_LINE_COLORS[i % BATCH_LINE_COLORS.length]),
                    borderWidth: 2,
                    borderRadius: 6,
                },
                {
                    label: 'Min Sats',
                    data: allResults.map((r) => r.summary.sats_min),
                    backgroundColor: 'rgba(239, 71, 111, 0.3)',
                    borderColor: '#ef476f',
                    borderWidth: 1,
                    borderRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true },
                tooltip: {
                    backgroundColor: 'rgba(18, 18, 22, 0.96)',
                    titleColor: '#f4f4f5',
                    bodyColor: '#a1a1aa',
                    borderColor: 'rgba(255, 255, 255, 0.12)',
                },
            },
            scales: {
                x: {
                    ticks: { color: '#71717a', maxRotation: 45 },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                },
                y: {
                    title: { display: true, text: 'Satellites', color: '#71717a' },
                    ticks: { color: '#71717a' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                },
            },
        },
    });

    // HDOP comparison
    const ctx2 = document.getElementById('chart-batch-hdop');
    batchCharts['chart-batch-hdop'] = new Chart(ctx2, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Avg HDOP',
                    data: allResults.map((r) => r.summary.hdop_avg),
                    backgroundColor: allResults.map((_, i) => BATCH_LINE_COLORS[i % BATCH_LINE_COLORS.length] + '99'),
                    borderColor: allResults.map((_, i) => BATCH_LINE_COLORS[i % BATCH_LINE_COLORS.length]),
                    borderWidth: 2,
                    borderRadius: 6,
                },
                {
                    label: 'Max HDOP',
                    data: allResults.map((r) => r.summary.hdop_max),
                    backgroundColor: 'rgba(245, 158, 11, 0.25)',
                    borderColor: '#f59e0b',
                    borderWidth: 1,
                    borderRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true },
                tooltip: {
                    backgroundColor: 'rgba(18, 18, 22, 0.96)',
                    titleColor: '#f4f4f5',
                    bodyColor: '#a1a1aa',
                    borderColor: 'rgba(255, 255, 255, 0.12)',
                },
            },
            scales: {
                x: {
                    ticks: { color: '#71717a', maxRotation: 45 },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                },
                y: {
                    title: { display: true, text: 'HDOP', color: '#71717a' },
                    ticks: { color: '#71717a' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                },
            },
        },
    });
}

// ======================================================================
// Takeoff & Landing Precision Analysis (Sub-Meter Accuracy)
// ======================================================================
function renderPrecisionAnalysis(summary) {
    if (!summary) return;

    const startAlt = summary.start_alt !== undefined ? summary.start_alt : '—';
    const endAlt = summary.end_alt !== undefined ? summary.end_alt : '—';
    const altDiff = summary.alt_diff !== undefined ? summary.alt_diff : 0;
    const altDiffCm = summary.alt_diff_cm !== undefined ? summary.alt_diff_cm : 0;
    const landingDistM = summary.takeoff_to_landing_dist_m !== undefined ? summary.takeoff_to_landing_dist_m : 0;
    const landingDistCm = summary.takeoff_to_landing_dist_cm !== undefined ? summary.takeoff_to_landing_dist_cm : 0;
    const dist3dM = summary.takeoff_to_landing_3d_m !== undefined ? summary.takeoff_to_landing_3d_m : 0;
    const dist3dCm = summary.takeoff_to_landing_3d_cm !== undefined ? summary.takeoff_to_landing_3d_cm : 0;

    // Start Alt
    const startAltEl = document.getElementById('prec-start-alt');
    if (startAltEl) startAltEl.textContent = startAlt;
    const startSubEl = document.getElementById('prec-start-sub');
    if (startSubEl) {
        startSubEl.textContent = summary.start_lat ? `${summary.start_lat.toFixed(6)}, ${summary.start_lng.toFixed(6)}` : 'Takeoff position';
    }

    // End Alt
    const endAltEl = document.getElementById('prec-end-alt');
    if (endAltEl) endAltEl.textContent = endAlt;
    const endSubEl = document.getElementById('prec-end-sub');
    if (endSubEl) {
        endSubEl.textContent = summary.end_lat ? `${summary.end_lat.toFixed(6)}, ${summary.end_lng.toFixed(6)}` : 'Touchdown position';
    }

    // Alt Diff
    const diffSign = altDiff > 0 ? '+' : '';
    const altDiffEl = document.getElementById('prec-alt-diff');
    if (altDiffEl) altDiffEl.textContent = `${diffSign}${altDiff}`;
    const altDiffCmEl = document.getElementById('prec-alt-diff-cm');
    if (altDiffCmEl) altDiffCmEl.textContent = `${diffSign}${altDiffCm} cm vertical drift`;

    const diffBox = document.getElementById('box-alt-diff');
    if (diffBox) {
        if (Math.abs(altDiff) <= 0.5) {
            diffBox.style.borderColor = 'rgba(34, 197, 94, 0.4)';
        } else if (Math.abs(altDiff) <= 1.5) {
            diffBox.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        } else {
            diffBox.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        }
    }

    // Horizontal Distance
    const landingDistEl = document.getElementById('prec-landing-dist');
    if (landingDistEl) landingDistEl.textContent = landingDistM;
    const landingDistCmEl = document.getElementById('prec-landing-dist-cm');
    if (landingDistCmEl) landingDistCmEl.textContent = `${landingDistCm} cm horizontal displacement`;

    // 3D Distance
    const dist3dEl = document.getElementById('prec-3d-dist');
    if (dist3dEl) dist3dEl.textContent = dist3dM;
    const dist3dCmEl = document.getElementById('prec-3d-dist-cm');
    if (dist3dCmEl) dist3dCmEl.textContent = `${dist3dCm} cm 3D spatial vector`;

    // Sub-meter repeatability badge
    const badgeEl = document.getElementById('precision-badge');
    if (badgeEl) {
        let badgeHtml = '';
        if (landingDistM < 0.5) {
            badgeHtml = `<span class="precision-badge-pill precision-badge-submeter">🎯 Sub-Half-Meter Precision (${landingDistCm} cm)</span>`;
        } else if (landingDistM < 1.0) {
            badgeHtml = `<span class="precision-badge-pill precision-badge-submeter">🎯 Sub-Meter Repeatability (${landingDistCm} cm)</span>`;
        } else if (landingDistM < 2.5) {
            badgeHtml = `<span class="precision-badge-pill precision-badge-good">📍 High Accuracy Landing (${landingDistM} m)</span>`;
        } else {
            badgeHtml = `<span class="precision-badge-pill precision-badge-warn">📍 Standard Landing Offset (${landingDistM} m)</span>`;
        }
        badgeEl.innerHTML = badgeHtml;
    }

    // Dynamic Summary Text
    const summaryTextEl = document.getElementById('precision-summary-text');
    if (summaryTextEl) {
        const accuracyVerdict = landingDistM < 1.0
            ? '<strong style="color:#06d6a0;">Sub-Meter Precision achieved</strong> (high RTL return / landing pad repeatability)'
            : landingDistM < 2.5
            ? '<strong style="color:#118ab2;">Standard GPS RTL Return accuracy</strong>'
            : '<strong style="color:#ffd166;">Landing location is offset from takeoff</strong> (or point-to-point mission flight)';

        summaryTextEl.innerHTML = `
            The vehicle took off at <strong>${startAlt} m MSL</strong> and landed at <strong>${endAlt} m MSL</strong>, resulting in an altitude difference of <strong>${diffSign}${altDiff} m (${diffSign}${altDiffCm} cm)</strong>. 
            The horizontal distance between the takeoff location and touchdown point was measured at <strong>${landingDistM} m (${landingDistCm} cm)</strong> with a total 3D spatial displacement of <strong>${dist3dM} m</strong>.
            Evaluation: ${accuracyVerdict}.
        `;
    }
}

// ======================================================================
// Batch CSV Export
// ======================================================================
function exportBatchCSV() {
    if (!allResults.length) return;

    const headers = [
        'Filename', 'Verdict', 'Score', 'Duration_min', 'Distance_km',
        'Takeoff_Alt_m', 'Landing_Alt_m', 'Alt_Diff_m', 'Landing_Dist_m', 'Landing_3D_m',
        'Samples', 'Best_Fix', 'Pct_3D_Plus', 'Sats_Avg', 'HDOP_Avg',
        'HAcc_Avg', 'Speed_Max',
    ];

    const rows = allResults.map((r) => {
        const s = r.summary;
        const v = s.verdict || {};
        return [
            r.filename, v.rating || 'GOOD', v.score ?? '', s.time_span_min, s.distance_km ?? '',
            s.start_alt ?? '', s.end_alt ?? '', s.alt_diff ?? '', s.takeoff_to_landing_dist_m ?? '', s.takeoff_to_landing_3d_m ?? '',
            s.total_samples, s.best_fix, s.pct_3d_or_better, s.sats_avg, s.hdop_avg,
            s.hacc_avg ?? '', s.speed_max,
        ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    downloadFile(csv, `batch_gps_summary_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
