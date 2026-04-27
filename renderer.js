const { ipcRenderer, shell } = require('electron');

const accountGrid = document.getElementById('account-grid');
const addAccountBtn = document.getElementById('add-account-btn');
const accountModal = document.getElementById('account-modal');
const modalTitle = document.getElementById('modal-title');
const modalSave = document.getElementById('modal-save');
const modalCancel = document.getElementById('modal-cancel');
const testProxyBtn = document.getElementById('test-proxy-btn');
const testStatus = document.getElementById('test-status');

const totalAccountsLabel = document.getElementById('total-accounts');
const runningCountLabel = document.getElementById('running-count');
const healthyProxyCountLabel = document.getElementById('healthy-proxy-count');
const profileSearch = document.getElementById('profile-search');
const warningCountBadge = document.getElementById('warning-count-badge');

const toggleProxyMode = document.getElementById('toggle-proxy-mode');
const proxyDetailMode = document.getElementById('proxy-detail-mode');
const proxySimpleMode = document.getElementById('proxy-simple-mode');
const proxyUrlSimple = document.getElementById('proxy-url-simple');

const chromeModal = document.getElementById('chrome-modal');
const btnDownloadChrome = document.getElementById('btn-download-chrome');
const btnSelectChrome = document.getElementById('btn-select-chrome');

let isEditMode = false;
let currentEditId = null;
let isDetailedMode = true;
let accountsData = [];
let activeFilter = 'all';

const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

const LOCATION_BY_TZ = {
    'Asia/Shanghai': '中国大陆 (CN)',
    'Asia/Hong_Kong': '中国香港 (HK)',
    'Asia/Singapore': '新加坡 (SG)',
    'Asia/Tokyo': '日本 (JP)',
    'America/New_York': '美国 (US)',
    'America/Los_Angeles': '美国 (US)',
    'Europe/London': '英国 (GB)',
    'Europe/Berlin': '德国 (DE)',
};

function getChromeVersion(ua) {
    const match = (ua || '').match(/Chrome\/([\d.]+)/);
    return match ? match[1] : '123.0.0.0';
}

function getDisplayName(acc, index) {
    const trimmed = (acc.name || '').trim();
    if (!trimmed) return String(index + 1);
    return trimmed.length <= 8 ? trimmed : trimmed.replace(/^账号0?/, '').replace(/-.*/, '') || String(index + 1);
}

function getProxyMeta(acc, index) {
    const proxy = parseProxyString(acc.proxy || '');
    const hasProxy = Boolean(proxy.host && proxy.port);
    const host = hasProxy ? proxy.host : '未配置代理';
    const location = LOCATION_BY_TZ[acc.timezone] || (hasProxy ? '未知' : '系统网络');
    return { hasProxy, host, location };
}

function isProxyWarning(acc) {
    return Boolean(acc.proxy && !acc.timezone);
}

function statusFor(acc) {
    if (acc.isRunning) return { key: 'running', label: '运行中' };
    if (isProxyWarning(acc)) return { key: 'warning', label: '需检查' };
    return { key: 'idle', label: '等待启动' };
}

function updateStats(accounts) {
    const runningCount = accounts.filter(acc => acc.isRunning).length;
    const warningCount = accounts.filter(isProxyWarning).length;
    const proxyCount = accounts.filter(acc => {
        const proxy = parseProxyString(acc.proxy || '');
        return Boolean(proxy.host && proxy.port);
    }).length;
    const healthyCount = Math.max(0, proxyCount - warningCount);

    totalAccountsLabel.innerText = accounts.length;
    runningCountLabel.innerText = runningCount;
    healthyProxyCountLabel.innerText = healthyCount;
    if (warningCountBadge) {
        warningCountBadge.textContent = warningCount;
        warningCountBadge.hidden = warningCount === 0;
    }
}

function getFilteredAccounts() {
    const query = (profileSearch?.value || '').trim().toLowerCase();
    return accountsData.filter((acc, index) => {
        const status = statusFor(acc).key;
        const filterMatch =
            activeFilter === 'all' ||
            (activeFilter === 'running' && status === 'running') ||
            (activeFilter === 'warning' && status === 'warning') ||
            (activeFilter === 'idle' && status === 'idle');

        if (!filterMatch) return false;
        if (!query) return true;

        const displayName = getDisplayName(acc, index);
        const searchParts = [acc.name || '', displayName, String(acc.id || ''), String(acc.id || '').slice(-6), acc.proxy || '', String(index + 1)];
        const searchTarget = searchParts.join(' ').toLowerCase();
        return searchTarget.includes(query);
    });
}

function renderAccounts(accounts) {
    accountsData = accounts;
    updateStats(accounts);
    accountGrid.innerHTML = '';

    const visibleAccounts = getFilteredAccounts();
    if (visibleAccounts.length === 0) {
        accountGrid.innerHTML = '<div class="empty-state">暂无匹配环境</div>';
        return;
    }

    visibleAccounts.forEach((acc) => {
        const originalIndex = accountsData.findIndex(item => item.id === acc.id);
        const proxy = getProxyMeta(acc, originalIndex);
        const status = statusFor(acc);
        const statusClass = status.key === 'running' ? 'running' : status.key === 'warning' ? 'warning-state' : '';
        const launchLabel = acc.isRunning ? '打开' : '启动';
        const lastUsed = acc.lastUsed || '暂无记录';

        const card = document.createElement('article');
        card.className = `account-card ${acc.isRunning ? 'running' : ''}`;
        card.dataset.id = acc.id;

        card.innerHTML = `
            <div class="card-header">
                <div class="avatar-wrapper">
                    <img src="whatsapp.png" alt="WhatsApp">
                    <div class="status-dot"></div>
                </div>
                <div class="header-info">
                    <div class="title-line">
                        <div class="profile-name" title="${escapeHtml(acc.name || '')}">${escapeHtml(getDisplayName(acc, originalIndex))}</div>
                        <span class="state-label ${statusClass}">${status.label}</span>
                    </div>
                    <span class="id-tag">ID: ${escapeHtml(String(acc.id).slice(-6).padStart(6, '0'))}</span>
                </div>
            </div>

            <div class="badge-row">
                <span class="badge">${proxy.hasProxy ? '住宅代理' : '系统代理'}</span>
                ${acc.timezone ? `<span class="badge">${escapeHtml(acc.timezone)}</span>` : ''}
            </div>

            <div class="meta-lines">
                ${proxy.hasProxy ? `
                <div class="meta-row">
                    <span class="meta-item"><span class="meta-icon">◎</span>${escapeHtml(proxy.host)}</span>
                    <span class="meta-item"><span class="meta-icon">⌖</span>${escapeHtml(proxy.location)}</span>
                </div>
                ` : ''}
                ${status.key === 'warning' ? '<div class="meta-row warning-text">! 代理连接失败</div>' : ''}
                <div class="meta-row">
                    <span class="meta-item"><span class="meta-icon">◷</span>最后启动：${escapeHtml(lastUsed)}</span>
                </div>
            </div>

            <div class="card-footer">
                <button class="launch-btn" type="button" onclick="handleLaunch(event, '${acc.id}')">${launchLabel}</button>
                <div class="card-actions">
                    <button class="icon-btn" title="编辑" type="button" onclick="handleEdit(event, '${acc.id}')">${ICON_EDIT}</button>
                    <button class="icon-btn delete" title="删除" type="button" onclick="handleDelete(event, '${acc.id}')">${ICON_TRASH}</button>
                </div>
            </div>
        `;

        card.onclick = () => {
            if (!acc.isRunning) ipcRenderer.send('launch-profile', acc.id);
        };

        accountGrid.appendChild(card);
    });
}

function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

window.handleLaunch = (e, id) => {
    e.stopPropagation();
    ipcRenderer.send('launch-profile', id);
};

window.handleEdit = (e, id) => {
    e.stopPropagation();
    const acc = accountsData.find(a => a.id === id);
    if (!acc) return;
    isEditMode = true;
    currentEditId = id;
    modalTitle.innerText = '编辑指纹环境';
    resetForm();
    document.getElementById('acc-name').value = acc.name || '';
    const p = parseProxyString(acc.proxy || '');
    document.getElementById('proxy-host').value = p.host;
    document.getElementById('proxy-port').value = p.port;
    document.getElementById('proxy-user').value = p.user;
    document.getElementById('proxy-pass').value = p.pass;
    proxyUrlSimple.value = acc.proxy || '';
    accountModal.classList.add('active');
};

window.handleDelete = (e, id) => {
    e.stopPropagation();
    if (confirm('确定删除该环境？')) {
        ipcRenderer.send('delete-account', id);
    }
};

function resetForm() {
    document.getElementById('acc-name').value = '';
    document.getElementById('proxy-host').value = '';
    document.getElementById('proxy-port').value = '';
    document.getElementById('proxy-user').value = '';
    document.getElementById('proxy-pass').value = '';
    proxyUrlSimple.value = '';
    testStatus.innerText = '等待检测...';
    testStatus.style.color = '';
    testProxyBtn.disabled = false;
    delete testProxyBtn.dataset.timezone;
}

function parseProxyString(str) {
    const result = { host: '', port: '', user: '', pass: '' };
    if (!str) return result;
    str = str.trim().replace(/^(socks5?|http|socks5h|socks):\/\//i, '');
    const parts = str.split(':');
    if (parts.length === 4) {
        result.host = parts[0]; result.port = parts[1]; result.user = parts[2]; result.pass = parts[3];
    } else if (parts.length === 2) {
        result.host = parts[0]; result.port = parts[1];
    }
    return result;
}

function buildProxyString() {
    if (!isDetailedMode) return proxyUrlSimple.value.trim();
    const host = document.getElementById('proxy-host').value.trim();
    const port = document.getElementById('proxy-port').value.trim();
    const user = document.getElementById('proxy-user').value.trim();
    const pass = document.getElementById('proxy-pass').value.trim();
    if (!host || !port) return '';
    const auth = user && pass ? `${user}:${pass}@` : '';
    return `socks5://${auth}${host}:${port}`;
}

async function initApp() {
    const version = await ipcRenderer.invoke('get-version');
    const label = document.getElementById('app-version-label');
    if (label) label.innerText = `V ${version}`;

    ipcRenderer.on('accounts-list', (event, accounts) => renderAccounts(accounts));
    ipcRenderer.on('process-started', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('process-ended', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('chrome-not-found', () => chromeModal.classList.add('active'));

    btnDownloadChrome.onclick = () => shell.openExternal('https://www.google.com/chrome/');
    btnSelectChrome.onclick = () => ipcRenderer.send('select-chrome-path');
    
    addAccountBtn.onclick = () => {
        isEditMode = false;
        currentEditId = null;
        modalTitle.innerText = '新建指纹环境';
        resetForm();
        accountModal.classList.add('active');
    };

    modalCancel.onclick = () => accountModal.classList.remove('active');
    
    modalSave.onclick = () => {
        const name = document.getElementById('acc-name').value.trim();
        const proxy = buildProxyString();
        const timezone = testProxyBtn.dataset.timezone || '';
        if (!name) return alert('请输入名称');
        const data = { name, proxy, timezone };
        if (isEditMode) {
            ipcRenderer.send('update-account', { id: currentEditId, ...data });
        } else {
            ipcRenderer.send('add-account', data);
        }
        accountModal.classList.remove('active');
    };

    toggleProxyMode.onclick = (e) => {
        e.preventDefault();
        isDetailedMode = !isDetailedMode;
        toggleProxyMode.innerText = isDetailedMode ? '切换到一键粘贴' : '切换到详细填写';
        proxyDetailMode.style.display = isDetailedMode ? 'block' : 'none';
        proxySimpleMode.style.display = isDetailedMode ? 'none' : 'block';
    };

    testProxyBtn.onclick = async () => {
        const proxyStr = buildProxyString();
        if (!proxyStr) return alert('请先输入代理信息');
        testStatus.innerText = '正在检测...';
        testProxyBtn.disabled = true;
        try {
            const result = await ipcRenderer.invoke('test-proxy', parseProxyString(proxyStr));
            if (result.success) {
                testStatus.innerText = `通过 ${result.country || ''}`;
                testStatus.style.color = '#147a42';
                testProxyBtn.dataset.timezone = result.timezone;
            } else {
                testStatus.innerText = '连接失败';
                testStatus.style.color = '#f59e0b';
            }
        } finally {
            testProxyBtn.disabled = false;
        }
    };

    profileSearch?.addEventListener('input', () => renderAccounts(accountsData));
    
    // 重新绑定分类按钮
    document.querySelectorAll('.segment').forEach(button => {
        button.addEventListener('click', (e) => {
            console.log('Segment clicked:', button.dataset.filter);
            document.querySelectorAll('.segment').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            activeFilter = button.dataset.filter || 'all';
            renderAccounts(accountsData);
        });
    });

    ipcRenderer.send('get-accounts');
}

document.addEventListener('DOMContentLoaded', initApp);
