// ============================================
// FT-LLM Demo - Dashboard JavaScript
// ============================================

// Utility functions
function uuid8() {
    return 'xxxx-xxxx'.replace(/[x]/g, c => (Math.random() * 16 | 0).toString(16));
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString();
}

// Configuration
const room = 'ft-llm';
const clientId = `ui-${uuid8()}`;
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProto}//${location.host}/ws/${room}/${clientId}?role=ui`;

// State
let ws;
let latestGpuStatus = null;
let hpcConnected = false;
let currentRequestId = null;

// KV / RS topology state (purely visual)
let topologyState = {
    inferenceActive: false,
    rsEncodeActive: false,
    rsDecodeActive: false,
    degradedMode: false,
    failedGpuId: null,
};

// Chart configuration
const MAX_DATA_POINTS = 60;  // Keep last N points
let throughputChart, latencyChart, tpChart;
let chartData = {
    labels: [],
    throughput: [],
    latency: [],
    tpSize: [],
    annotations: []
};

// DOM elements
const gpuGrid = document.getElementById('gpu-grid');
const outputEl = document.getElementById('output');
const eventsEl = document.getElementById('events');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const hpcStatusEl = document.getElementById('hpc-status');
const tpSizeEl = document.getElementById('tp-size');
const currentThroughputEl = document.getElementById('current-throughput');

// ============================================
// Chart Initialization
// ============================================

function initCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
            x: {
                display: true,
                ticks: { maxTicksLimit: 6, font: { size: 10 } },
            },
            y: {
                beginAtZero: true,
                ticks: { font: { size: 10 } },
            }
        },
        plugins: {
            legend: { display: false }
        }
    };

    const throughputCtx = document.getElementById('throughput-chart').getContext('2d');
    throughputChart = new Chart(throughputCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Throughput',
                data: [],
                borderColor: '#28a745',
                backgroundColor: 'rgba(40, 167, 69, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 0
            }]
        },
        options: {
            ...commonOptions,
            scales: {
                ...commonOptions.scales,
                y: {
                    ...commonOptions.scales.y,
                    title: { display: true, text: 'tok/s', font: { size: 10 } }
                }
            }
        }
    });

    const latencyCtx = document.getElementById('latency-chart').getContext('2d');
    latencyChart = new Chart(latencyCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Latency',
                data: [],
                borderColor: '#dc3545',
                backgroundColor: 'rgba(220, 53, 69, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 0
            }]
        },
        options: {
            ...commonOptions,
            scales: {
                ...commonOptions.scales,
                y: {
                    ...commonOptions.scales.y,
                    title: { display: true, text: 'ms', font: { size: 10 } }
                }
            }
        }
    });

    const tpCtx = document.getElementById('tp-chart').getContext('2d');
    tpChart = new Chart(tpCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'TP Size',
                data: [],
                borderColor: '#007bff',
                backgroundColor: 'rgba(0, 123, 255, 0.2)',
                fill: true,
                tension: 0,
                stepped: true,
                pointRadius: 0
            }]
        },
        options: {
            ...commonOptions,
            scales: {
                ...commonOptions.scales,
                y: {
                    ...commonOptions.scales.y,
                    min: 0,
                    max: 5,
                    ticks: { stepSize: 1, font: { size: 10 } },
                    title: { display: true, text: 'GPUs', font: { size: 10 } }
                }
            }
        }
    });
}

function updateCharts(metrics) {
    const now = formatTime(Date.now());

    chartData.labels.push(now);
    chartData.throughput.push(metrics.throughput || 0);
    chartData.latency.push(metrics.latency || 0);
    chartData.tpSize.push(metrics.tp_size || 0);

    if (chartData.labels.length > MAX_DATA_POINTS) {
        chartData.labels.shift();
        chartData.throughput.shift();
        chartData.latency.shift();
        chartData.tpSize.shift();
    }

    throughputChart.data.labels = chartData.labels;
    throughputChart.data.datasets[0].data = chartData.throughput;
    throughputChart.update('none');

    latencyChart.data.labels = chartData.labels;
    latencyChart.data.datasets[0].data = chartData.latency;
    latencyChart.update('none');

    tpChart.data.labels = chartData.labels;
    tpChart.data.datasets[0].data = chartData.tpSize;
    tpChart.update('none');

    if (currentThroughputEl && metrics.throughput !== undefined) {
        currentThroughputEl.innerHTML = `${metrics.throughput.toFixed(1)} <small>tok/s</small>`;
    }
}

function addChartAnnotation(label) {
    // Right now just log in events; can integrate annotation plugin later
    appendEvent(`📍 Chart marker: ${label}`);
}

// ============================================
// Event Logging
// ============================================

function appendEvent(msg, type = 'info') {
    const timestamp = formatTime(Date.now());
    const prefix = type === 'error' ? '❌'
        : type === 'success' ? '✅'
        : type === 'warning' ? '⚠️'
        : 'ℹ️';
    eventsEl.textContent += `[${timestamp}] ${prefix} ${msg}\n`;
    eventsEl.scrollTop = eventsEl.scrollHeight;
}

function clearEvents() {
    eventsEl.textContent = '';
    appendEvent('Events cleared', 'info');
}

// ============================================
// Topology Visualization
// ============================================

function renderTopology() {
    const topoRoot = document.getElementById('tp-topology');
    if (!topoRoot) return;

    // Root classes control bus animations
    topoRoot.classList.toggle('tp-inference-active', topologyState.inferenceActive);
    topoRoot.classList.toggle('tp-encode-active', topologyState.rsEncodeActive);
    topoRoot.classList.toggle('tp-decode-active', topologyState.rsDecodeActive);
    topoRoot.classList.toggle('tp-degraded', topologyState.degradedMode);

    // CPU DRAM fill: idle vs encode/decode vs inference
    const cpuFill = document.getElementById('tp-cpu-mem-fill');
    if (cpuFill) {
        let width = 10;
        if (topologyState.rsEncodeActive || topologyState.rsDecodeActive) {
            width = 75;
        } else if (topologyState.inferenceActive) {
            width = 45;
        } else {
            width = 15;
        }
        cpuFill.style.width = `${width}%`;
    }

    // Mini GPU nodes mirror real GPU states
    if (latestGpuStatus && latestGpuStatus.gpus) {
        latestGpuStatus.gpus.forEach(g => {
            const node = document.getElementById(`tp-gpu-${g.id}`);
            if (!node) return;
            node.classList.remove('gpu-healthy', 'gpu-failed', 'gpu-recovering', 'gpu-unknown');
            node.classList.add(`gpu-${g.state || 'unknown'}`);
            const label = node.querySelector('.tp-gpu-label');
            if (label) label.textContent = `GPU ${g.id}`;
        });
    }

    // Badges in header
    const encodeBadge = document.getElementById('rs-encode-badge');
    const decodeBadge = document.getElementById('rs-decode-badge');
    const modeBadge = document.getElementById('topology-mode-badge');

    if (encodeBadge) {
        if (topologyState.rsEncodeActive) {
            encodeBadge.textContent = 'RS Encode: active';
            encodeBadge.className = 'badge bg-success me-1';
        } else if (topologyState.inferenceActive) {
            encodeBadge.textContent = 'RS Encode: streaming';
            encodeBadge.className = 'badge bg-info me-1';
        } else {
            encodeBadge.textContent = 'RS Encode: idle';
            encodeBadge.className = 'badge bg-secondary me-1';
        }
    }

    if (decodeBadge) {
        if (topologyState.rsDecodeActive) {
            decodeBadge.textContent = 'RS Decode: recovering';
            decodeBadge.className = 'badge bg-warning text-dark me-1';
        } else {
            decodeBadge.textContent = 'RS Decode: idle';
            decodeBadge.className = 'badge bg-secondary me-1';
        }
    }

    if (modeBadge) {
        if (topologyState.degradedMode) {
            modeBadge.textContent = 'Mode: degraded (TP < full)';
            modeBadge.className = 'badge bg-warning text-dark';
        } else {
            modeBadge.textContent = 'Mode: normal';
            modeBadge.className = 'badge bg-primary';
        }
    }

    // Controller list highlighting
    const setActive = (role, active) => {
        const li = document.querySelector(`.tp-controller-list li[data-role="${role}"]`);
        if (!li) return;
        li.classList.toggle('tp-active', !!active);
    };

    setActive('inference', topologyState.inferenceActive);
    setActive('gather', topologyState.inferenceActive);
    setActive('rs-encode', topologyState.rsEncodeActive);
    setActive('rs-decode', topologyState.rsDecodeActive);
    setActive('kv-cache', topologyState.rsEncodeActive || topologyState.rsDecodeActive);
    setActive('weights', latestGpuStatus && latestGpuStatus.gpus && latestGpuStatus.gpus.length > 1);
    setActive('degraded', topologyState.degradedMode);
}

// ============================================
// GPU Rendering
// ============================================

function renderGpus(status) {
    gpuGrid.innerHTML = '';

    if (!status || !status.gpus) {
        gpuGrid.innerHTML = '<div class="col-12 text-center text-muted">Waiting for HPC connection...</div>';
        // Still refresh topology (it will just be idle)
        renderTopology();
        return;
    }

    if (tpSizeEl) {
        tpSizeEl.textContent = status.tp_world_size || status.gpus.filter(g => g.state === 'healthy').length;
    }

    status.gpus.forEach(g => {
        const col = document.createElement('div');
        col.className = 'col-md-3 col-sm-6';

        let stateClass = 'gpu-unknown';
        let stateText = 'Unknown';
        let stateIcon = '❓';

        if (g.state === 'healthy') {
            stateClass = 'gpu-healthy';
            stateText = 'Healthy';
            stateIcon = '✓';
        } else if (g.state === 'failed') {
            stateClass = 'gpu-failed';
            stateText = 'Failed';
            stateIcon = '✗';
        } else if (g.state === 'recovering') {
            stateClass = 'gpu-recovering';
            stateText = 'Recovering';
            stateIcon = '↻';
        }

        const vramPercent = g.vram_total_gb > 0 ? (g.vram_used_gb / g.vram_total_gb) * 100 : 0;

        col.innerHTML = `
            <div class="gpu-card ${stateClass}">
                <div class="d-flex justify-content-between align-items-start mb-2">
                    <div>
                        <strong style="font-size: 18px;">GPU ${g.id}</strong>
                        <div style="font-size: 12px; opacity: 0.9;">${stateIcon} ${stateText}</div>
                    </div>
                    <button class="btn btn-sm btn-light kill-btn" 
                            data-gpu="${g.id}" 
                            ${g.state === 'failed' ? 'disabled' : ''}>
                        ${g.state === 'failed' ? '💀' : '🔪 Kill'}
                    </button>
                </div>
                <div style="font-size: 14px;">
                    VRAM: ${g.vram_used_gb.toFixed(1)} / ${g.vram_total_gb.toFixed(1)} GB
                </div>
                <div class="gpu-vram-bar">
                    <div class="gpu-vram-fill" style="width: ${vramPercent}%"></div>
                </div>
            </div>
        `;

        gpuGrid.appendChild(col);
    });

    gpuGrid.querySelectorAll('button[data-gpu]').forEach(btn => {
        btn.onclick = () => {
            const gpuId = parseInt(btn.getAttribute('data-gpu'));
            if (confirm(`Are you sure you want to kill GPU ${gpuId}?\n\nThis will simulate a GPU failure.`)) {
                sendKill(gpuId);
            }
        };
    });

    // Sync topology visualization
    renderTopology();
}

// ============================================
// WebSocket Connection
// ============================================

function connectWS() {
    console.log('Connecting to:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
        appendEvent('Connected to relay server', 'success');
        updateConnectionStatus(true);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        appendEvent('Disconnected from relay server', 'error');
        updateConnectionStatus(false);
        hpcConnected = false;
        updateHpcStatus(false);
        setTimeout(connectWS, 2000);
    };

    ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        appendEvent('WebSocket error', 'error');
    };

    ws.onmessage = (ev) => {
        try {
            const data = JSON.parse(ev.data);
            handleMessage(data);
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    };
}

function handleMessage(data) {
    const mtype = data.type;

    switch (mtype) {
        case 'gpu_status':
            latestGpuStatus = data;
            renderGpus(data);
            if (!hpcConnected) {
                hpcConnected = true;
                updateHpcStatus(true);
                appendEvent('HPC connected', 'success');
            }
            break;

        case 'metrics':
            updateCharts(data);
            break;

        case 'token_update':
            outputEl.textContent += data.token || '';
            if (data.finished) {
                outputEl.textContent += '\n\n--- Generation complete ---\n';
                appendEvent(`Request ${data.request_id} completed`, 'success');

                // Inference done → stop RS encode animation
                topologyState.inferenceActive = false;
                topologyState.rsEncodeActive = false;
                // RS decode may still be active if we're mid-recovery
                renderTopology();
            }
            outputEl.scrollTop = outputEl.scrollHeight;
            break;

        case 'event':
            appendEvent(data.msg || JSON.stringify(data));
            break;

        case 'recovery_event': {
            const recoveryType = data.event === 'complete' ? 'success'
                : data.event === 'failed' ? 'error'
                : 'warning';
            appendEvent(`🔧 RECOVERY: ${data.msg}`, recoveryType);
            addChartAnnotation(data.msg);

            const ev = data.event;
            if (ev === 'started') {
                topologyState.degradedMode = true;
                topologyState.rsDecodeActive = false;
            } else if (ev === 'kv_recovery') {
                topologyState.degradedMode = true;
                topologyState.rsDecodeActive = true;
                topologyState.rsEncodeActive = false;
            } else if (ev === 'degraded_complete') {
                topologyState.degradedMode = true;
                topologyState.rsDecodeActive = false;
            } else if (ev && ev.startsWith('hotswap_')) {
                topologyState.degradedMode = true;
                topologyState.rsDecodeActive = true;
            } else if (ev === 'complete') {
                topologyState.degradedMode = false;
                topologyState.rsDecodeActive = false;
            }

            renderTopology();
            break;
        }

        case 'status':
            if (data.status === 'disconnected' && data.role === 'hpc') {
                hpcConnected = false;
                updateHpcStatus(false);
                appendEvent('HPC disconnected', 'error');
                renderGpus(null);

                topologyState = {
                    inferenceActive: false,
                    rsEncodeActive: false,
                    rsDecodeActive: false,
                    degradedMode: false,
                    failedGpuId: null,
                };
                renderTopology();
            } else if (data.status === 'connected' && data.role === 'hpc') {
                hpcConnected = true;
                updateHpcStatus(true);
                appendEvent('HPC connected', 'success');
            }
            break;

        default:
            console.log('Unknown message type:', mtype, data);
    }
}

function updateConnectionStatus(connected) {
    const el = document.getElementById('relay-status');
    if (el) {
        el.className = `status-badge ${connected ? 'status-connected' : 'status-disconnected'}`;
        el.textContent = connected ? 'Relay: Connected' : 'Relay: Disconnected';
    }
}

function updateHpcStatus(connected) {
    if (hpcStatusEl) {
        hpcStatusEl.className = `status-badge ${connected ? 'status-connected' : 'status-disconnected'}`;
        hpcStatusEl.textContent = connected ? 'HPC: Connected' : 'HPC: Disconnected';
    }
}

// ============================================
// Actions
// ============================================

function sendKill(gpuId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendEvent('Cannot send: not connected', 'error');
        return;
    }

    const msg = {
        type: 'kill_gpu',
        gpu_id: gpuId,
    };
    ws.send(JSON.stringify(msg));
    appendEvent(`🔪 Requested kill of GPU ${gpuId}`, 'warning');

    topologyState.degradedMode = true;
    topologyState.failedGpuId = gpuId;
    renderTopology();
}

function sendPrompt() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendEvent('Cannot send: not connected', 'error');
        return;
    }

    const prompt = promptEl.value.trim();
    if (!prompt) {
        appendEvent('Please enter a prompt', 'error');
        return;
    }

    const reqId = `req-${uuid8()}`;
    currentRequestId = reqId;
    outputEl.textContent = '';

    // Inference starts → TP + RS encode become active
    topologyState.inferenceActive = true;
    topologyState.rsEncodeActive = true;
    topologyState.rsDecodeActive = false;
    topologyState.degradedMode = false;
    renderTopology();

    const msg = {
        type: 'submit_prompt',
        request_id: reqId,
        prompt: prompt,
    };
    ws.send(JSON.stringify(msg));
    appendEvent(`📤 Submitted prompt (id=${reqId})`);
}

// ============================================
// Initialize
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    connectWS();

    if (sendBtn) {
        sendBtn.onclick = sendPrompt;
    }

    if (promptEl) {
        promptEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendPrompt();
            }
        });
    }

    renderGpus(null);
});

// Make clearEvents available globally
window.clearEvents = clearEvents;
