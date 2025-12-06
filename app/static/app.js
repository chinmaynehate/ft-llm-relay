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

// DOM elements
const gpuGrid = document.getElementById('gpu-grid');
const outputEl = document.getElementById('output');
const eventsEl = document.getElementById('events');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const hpcStatusEl = document.getElementById('hpc-status');
const tpSizeEl = document.getElementById('tp-size');

// Event logging
function appendEvent(msg, type = 'info') {
    const timestamp = formatTime(Date.now());
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    eventsEl.textContent += `[${timestamp}] ${prefix} ${msg}\n`;
    eventsEl.scrollTop = eventsEl.scrollHeight;
}

// GPU rendering
function renderGpus(status) {
    gpuGrid.innerHTML = '';
    
    if (!status || !status.gpus) {
        gpuGrid.innerHTML = '<div class="col-12 text-center text-muted">Waiting for HPC connection...</div>';
        return;
    }

    // Update header stats
    if (tpSizeEl) {
        tpSizeEl.textContent = status.tp_world_size || status.gpus.length;
    }

    status.gpus.forEach(g => {
        const col = document.createElement('div');
        col.className = 'col-md-3 col-sm-6';

        let stateClass = 'gpu-unknown';
        let stateText = 'Unknown';
        
        if (g.state === 'healthy') {
            stateClass = 'gpu-healthy';
            stateText = '✓ Healthy';
        } else if (g.state === 'failed') {
            stateClass = 'gpu-failed';
            stateText = '✗ Failed';
        } else if (g.state === 'recovering') {
            stateClass = 'gpu-recovering';
            stateText = '↻ Recovering';
        }

        const vramPercent = (g.vram_used_gb / g.vram_total_gb) * 100;

        col.innerHTML = `
            <div class="gpu-card ${stateClass}">
                <div class="d-flex justify-content-between align-items-start mb-2">
                    <div>
                        <strong style="font-size: 18px;">GPU ${g.id}</strong>
                        <div style="font-size: 12px; opacity: 0.9;">${stateText}</div>
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
            if (confirm(`Are you sure you want to kill GPU ${gpuId}?`)) {
                sendKill(gpuId);
            }
        };
    });
}

// WebSocket connection
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

        case 'token_update':
            outputEl.textContent += data.token || '';
            if (data.finished) {
                outputEl.textContent += '\n\n--- Generation complete ---\n';
                appendEvent(`Request ${data.request_id} completed`, 'success');
            }
            break;

        case 'event':
            appendEvent(data.msg || JSON.stringify(data));
            break;

        case 'recovery_event':
            appendEvent(`RECOVERY: ${data.msg}`, data.event === 'complete' ? 'success' : 'info');
            break;

        case 'metrics':
            // Could update a metrics display
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

// Actions
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
    appendEvent(`Requested kill of GPU ${gpuId}`);
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
    appendEvent(`Submitted prompt (id=${reqId})`);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    connectWS();

    if (sendBtn) {
        sendBtn.onclick = sendPrompt;
    }

    // Also allow Enter key to send (Shift+Enter for newline)
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
