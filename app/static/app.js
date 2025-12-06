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

// Chart configuration
const MAX_DATA_POINTS = 60;  // Keep last 60 seconds of data
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
        animation: {
            duration: 0  // Disable animation for real-time updates
        },
        scales: {
            x: {
                display: true,
                title: {
                    display: false
                },
                ticks: {
                    maxTicksLimit: 6,
                    font: { size: 10 }
                }
            },
            y: {
                beginAtZero: true,
                ticks: {
                    font: { size: 10 }
                }
            }
        },
        plugins: {
            legend: {
                display: false
            }
        }
    };

    // Throughput Chart
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
                    title: {
                        display: true,
                        text: 'tok/s',
                        font: { size: 10 }
                    }
                }
            }
        }
    });

    // Latency Chart
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
                    title: {
                        display: true,
                        text: 'ms',
                        font: { size: 10 }
                    }
                }
            }
        }
    });

    // TP Size Chart
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
                    ticks: {
                        stepSize: 1,
                        font: { size: 10 }
                    },
                    title: {
                        display: true,
                        text: 'GPUs',
                        font: { size: 10 }
                    }
                }
            }
        }
    });
}

function updateCharts(metrics) {
    const now = formatTime(Date.now());
    
    // Add new data point
    chartData.labels.push(now);
    chartData.throughput.push(metrics.throughput || 0);
    chartData.latency.push(metrics.latency || 0);
    chartData.tpSize.push(metrics.tp_size || 0);
    
    // Keep only last MAX_DATA_POINTS
    if (chartData.labels.length > MAX_DATA_POINTS) {
        chartData.labels.shift();
        chartData.throughput.shift();
        chartData.latency.shift();
        chartData.tpSize.shift();
    }
    
    // Update throughput chart
    throughputChart.data.labels = chartData.labels;
    throughputChart.data.datasets[0].data = chartData.throughput;
    throughputChart.update('none');
    
    // Update latency chart
    latencyChart.data.labels = chartData.labels;
    latencyChart.data.datasets[0].data = chartData.latency;
    latencyChart.update('none');
    
    // Update TP chart
    tpChart.data.labels = chartData.labels;
    tpChart.data.datasets[0].data = chartData.tpSize;
    tpChart.update('none');
    
    // Update current throughput display
    if (currentThroughputEl && metrics.throughput !== undefined) {
        currentThroughputEl.innerHTML = `${metrics.throughput.toFixed(1)} <small>tok/s</small>`;
    }
}

function addChartAnnotation(label, color = 'red') {
    // Add a vertical line annotation at current time
    // This marks events like "GPU killed" or "Recovery complete"
    const now = formatTime(Date.now());
    appendEvent(`📍 Chart marker: ${label}`);
}

// ============================================
// Event Logging
// ============================================

function appendEvent(msg, type = 'info') {
    const timestamp = formatTime(Date.now());
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
    eventsEl.textContent += `[${timestamp}] ${prefix} ${msg}\n`;
    eventsEl.scrollTop = eventsEl.scrollHeight;
}

function clearEvents() {
    eventsEl.textContent = '';
    appendEvent('Events cleared', 'info');
}

// ============================================
// GPU Rendering
// ============================================

function renderGpus(status) {
    gpuGrid.innerHTML = '';
    
    if (!status || !status.gpus) {
        gpuGrid.innerHTML = '<div class="col-12 text-center text-muted">Waiting for HPC connection...</div>';
        return;
    }

    // Update header stats
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

    // Attach kill handlers
    gpuGrid.querySelectorAll('button[data-gpu]').forEach(btn => {
        btn.onclick = () => {
            const gpuId = parseInt(btn.getAttribute('data-gpu'));
            if (confirm(`Are you sure you want to kill GPU ${gpuId}?\n\nThis will simulate a GPU failure.`)) {
                sendKill(gpuId);
            }
        };
    });
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
            }
            // Auto-scroll output
            outputEl.scrollTop = outputEl.scrollHeight;
            break;

        case 'event':
            appendEvent(data.msg || JSON.stringify(data));
            break;

        case 'recovery_event':
            const recoveryType = data.event === 'complete' ? 'success' : 
                                 data.event === 'failed' ? 'error' : 'warning';
            appendEvent(`🔧 RECOVERY: ${data.msg}`, recoveryType);
            addChartAnnotation(data.msg);
            break;

        case 'status':
            if (data.status === 'disconnected' && data.role === 'hpc') {
                hpcConnected = false;
                updateHpcStatus(false);
                appendEvent('HPC disconnected', 'error');
                renderGpus(null);
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
    // Initialize charts
    initCharts();
    
    // Connect WebSocket
    connectWS();

    // Setup event handlers
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

    // Initial render
    renderGpus(null);
});

// Make clearEvents available globally
window.clearEvents = clearEvents;
