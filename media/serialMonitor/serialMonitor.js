/* eslint-disable */
/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const DEBUG = true; // toggle via "Open Webview Developer Tools" → console
function dbg(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.debug('[serialMonitor]', ...args);
}

document.addEventListener('DOMContentLoaded', () => {
    const connectBtn = document.getElementById('connect-btn');
    const clearBtn = document.getElementById('clear-btn');
    const refreshPortsBtn = document.getElementById('refresh-ports-btn');
    const commandInput = document.getElementById('command-input');
    const sendBtn = document.getElementById('send-btn');
    const serialOutput = document.getElementById('serial-output');
    const portSelect = document.getElementById('port-select');
    const baudSelect = document.getElementById('baud-select');
    const nlSelect = document.getElementById('nl-select');
    const currentPortDisplay = document.getElementById('current-port-display');
    const modeBadge = document.getElementById('mode-badge');

    // State
    let isConnected = false;
    /** True after the initial restoreHistory has been applied (or skipped). */
    let bootstrapped = false;
    let currentMode = 'unknown';
    let nativeAvailable = false;
    let previousPortPaths = [];

    dbg('DOMContentLoaded — sending ready');

    // Notify extension we're ready to receive replay + status. The extension
    // will respond with restoreHistory (if any) → modeInfo → connected/disconnected → ports.
    vscode.postMessage({ type: 'ready' });

    // Handle messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        dbg('ext → webview:', message?.type, message);

        switch (message.type) {
            case 'modeInfo':
                currentMode = message.mode || 'unknown';
                nativeAvailable = !!message.nativeAvailable;
                updateModeBadge();
                if (!nativeAvailable && message.loadError) {
                    appendOutput(`\r\n[Embedder Monitor] Native serialport unavailable: ${message.loadError}\r\n`);
                }
                break;

            case 'ports':
                if (message.mode) {
                    currentMode = message.mode;
                    nativeAvailable = !!message.nativeAvailable;
                    updateModeBadge();
                }
                updatePortList(message.ports || [], message.defaultPort || '');
                break;

            case 'onData':
                appendOutput(message.data);
                break;

            case 'restoreHistory':
                if (typeof message.data === 'string' && message.data.length > 0) {
                    serialOutput.value = message.data;
                    scrollToBottom();
                }
                bootstrapped = true;
                dbg('history restored, bootstrapped=true');
                break;

            case 'connecting':
                connectBtn.textContent = 'Connecting...';
                connectBtn.disabled = true;
                if (message.mode) {
                    currentMode = message.mode;
                    updateModeBadge();
                }
                currentPortDisplay.textContent = `${message.path} @ ${message.baud}`;
                break;

            case 'connected':
                if (message.mode) {
                    currentMode = message.mode;
                    updateModeBadge();
                }
                if (message.path) {
                    currentPortDisplay.textContent = `${message.path} @ ${message.baud || baudSelect.value}`;
                }
                setConnectedState(true);
                break;

            case 'disconnected':
                setConnectedState(false);
                currentPortDisplay.textContent = 'Not connected';
                if (message.reason) {
                    appendOutput(`\r\n[Embedder Monitor] Disconnected: ${message.reason}\r\n`);
                }
                break;

            case 'error': {
                const path = message.path ? ` (${message.path})` : '';
                appendOutput(`\r\n[ERROR]${path} ${message.message || 'unknown error'}\r\n`);
                break;
            }

            default:
                dbg('unknown message type', message?.type);
        }

        // After the very first message, mark bootstrapped to prevent any later
        // restoreHistory race from clobbering live data.
        if (!bootstrapped) {
            bootstrapped = true;
        }
    });

    // Event Listeners
    connectBtn.addEventListener('click', () => {
        if (!isConnected) {
            const port = portSelect.value;
            const baud = parseInt(baudSelect.value, 10);
            if (!port) {
                appendOutput('\r\n[Embedder Monitor] No port selected.\r\n');
                return;
            }
            dbg('connect click', { port, baud });
            vscode.postMessage({ type: 'connect', port, baud });
            connectBtn.textContent = 'Connecting...';
            connectBtn.disabled = true;
        } else {
            dbg('disconnect click');
            vscode.postMessage({ type: 'disconnect' });
        }
    });

    clearBtn.addEventListener('click', () => {
        serialOutput.value = '';
    });

    refreshPortsBtn.addEventListener('click', () => {
        dbg('refresh ports click');
        vscode.postMessage({ type: 'listPorts' });
    });

    const sendCommand = () => {
        if (!isConnected) {
            return;
        }
        const text = commandInput.value;
        const newline = nlSelect.value;
        dbg('send', { text, newlineLen: newline.length });
        vscode.postMessage({ type: 'send', message: text, newline });
        commandInput.value = '';
    };

    sendBtn.addEventListener('click', sendCommand);

    commandInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendCommand();
        }
    });

    // Helpers
    function updatePortList(ports, defaultPort) {
        const currentSelection = portSelect.value;
        portSelect.innerHTML = '';

        if (!ports || ports.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.text = nativeAvailable ? 'No ports detected' : 'No virtual ports';
            portSelect.add(option);
            previousPortPaths = [];
            currentPortDisplay.textContent = 'Not connected';
            return;
        }

        ports.forEach(port => {
            const option = document.createElement('option');
            // ports may be either string (legacy) or { path, label, virtual }
            if (typeof port === 'string') {
                option.value = port;
                option.text = port;
            } else {
                option.value = port.path;
                option.text = port.label || port.path;
                if (port.virtual) {
                    option.text = '🟡 ' + option.text;
                }
            }
            portSelect.add(option);
        });

        const candidatePaths = ports.map(p => (typeof p === 'string' ? p : p.path));
        const newlyAddedPaths = candidatePaths.filter(p => !previousPortPaths.includes(p));

        if (isConnected && currentSelection && candidatePaths.includes(currentSelection)) {
            portSelect.value = currentSelection;
        } else if (!isConnected && newlyAddedPaths.length > 0) {
            portSelect.value = newlyAddedPaths[newlyAddedPaths.length - 1];
        } else if (defaultPort && candidatePaths.includes(defaultPort)) {
            portSelect.value = defaultPort;
        } else {
            portSelect.selectedIndex = 0;
        }

        previousPortPaths = candidatePaths;

        if (!isConnected) {
            currentPortDisplay.textContent = portSelect.value || 'Not connected';
        }
    }

    function setConnectedState(connected) {
        isConnected = connected;
        connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
        connectBtn.disabled = false;

        commandInput.disabled = !connected;
        sendBtn.disabled = !connected;
        portSelect.disabled = connected;
        baudSelect.disabled = connected;

        if (connected) {
            connectBtn.classList.remove('primary');
            commandInput.focus();
        } else {
            connectBtn.classList.add('primary');
        }
    }

    function updateModeBadge() {
        if (!modeBadge) {
            return;
        }
        modeBadge.classList.remove('badge-real', 'badge-virtual', 'badge-unknown');
        if (currentMode === 'real') {
            modeBadge.textContent = 'REAL';
            modeBadge.classList.add('badge-real');
            modeBadge.title = 'Native serialport loaded — real hardware mode';
        } else if (currentMode === 'virtual') {
            modeBadge.textContent = 'VIRTUAL';
            modeBadge.classList.add('badge-virtual');
            modeBadge.title = 'Virtual simulator (native serialport unavailable or fallback)';
        } else {
            modeBadge.textContent = '…';
            modeBadge.classList.add('badge-unknown');
            modeBadge.title = 'Probing native serial mode';
        }
    }

    function appendOutput(data) {
        if (typeof data !== 'string') {
            return;
        }
        serialOutput.value += data;
        scrollToBottom();
    }

    function scrollToBottom() {
        serialOutput.scrollTop = serialOutput.scrollHeight;
    }
});
