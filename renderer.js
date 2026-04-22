const { ipcRenderer, shell } = require('electron');

// DOM 元素引用
const accountGrid = document.getElementById('account-grid');
const addAccountBtn = document.getElementById('add-account-btn');
const accountModal = document.getElementById('account-modal');
const modalCancel = document.getElementById('modal-cancel');
const modalSave = document.getElementById('modal-save');
const modalTitle = document.getElementById('modal-title');
const testProxyBtn = document.getElementById('test-proxy-btn');
const testStatus = document.getElementById('test-status');
const totalAccountsLabel = document.getElementById('total-accounts');

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
// 动态从主进程获取版本号


// 1. 列表渲染逻辑 (卡片布局)
function renderAccounts(accounts) {
    accountsData = accounts;
    accountGrid.innerHTML = '';
    totalAccountsLabel.innerText = accounts.length;

    if (accounts.length === 0) {
        accountGrid.innerHTML = '<div class="empty-state">暂无环境，请点击右上角新建</div>';
        return;
    }

    accounts.forEach(acc => {
        const card = document.createElement('div');
        card.className = `account-card ${acc.isRunning ? 'running' : ''}`;
        
        const proxyTag = acc.proxy ? '<span class="badge blue">住宅代理</span>' : '<span class="badge grey">系统代理</span>';
        const uaTag = `<span class="badge grey">Chrome ${acc.ua ? acc.ua.split('Chrome/')[1].split(' ')[0] : 'Latest'}</span>`;

        card.innerHTML = `
            <div class="card-header">
                <div class="avatar-wrapper">
                    <img src="whatsapp.png" alt="Icon">
                    <div class="status-dot"></div>
                </div>
                <div class="header-info">
                    <h2>${acc.name}</h2>
                    <span class="id-tag">ID: ${acc.id.slice(-6)}</span>
                </div>
            </div>
            
            <div class="card-body">
                <div class="badge-row">
                    ${proxyTag}
                    ${uaTag}
                    <span class="badge grey">${acc.timezone || '自动时区'}</span>
                </div>
            </div>

            <div class="card-footer">
                <div class="launch-status">
                    ${acc.isRunning ? '<span class="pulse-icon">●</span> 运行中' : '等待启动'}
                </div>
                <div class="card-actions">
                    <button class="icon-btn" title="编辑" onclick="handleEdit(event, '${acc.id}')">✏️</button>
                    <button class="icon-btn delete" title="删除" onclick="handleDelete(event, '${acc.id}')">🗑️</button>
                </div>
            </div>
        `;
        
        card.onclick = (e) => {
            if (e.target.closest('.icon-btn')) return;
            if (!acc.isRunning) ipcRenderer.send('launch-profile', acc.id);
        };
        accountGrid.appendChild(card);
    });
}

// 2. 弹窗交互
addAccountBtn.onclick = () => {
    isEditMode = false;
    currentEditId = null;
    modalTitle.innerText = '新建指纹环境';
    resetForm();
    accountModal.classList.add('active');
};

modalCancel.onclick = () => accountModal.classList.remove('active');

window.handleEdit = (e, id) => {
    e.stopPropagation();
    const acc = accountsData.find(a => a.id === id);
    if (!acc) return;

    isEditMode = true;
    currentEditId = id;
    modalTitle.innerText = '编辑指纹环境';
    resetForm();
    
    document.getElementById('acc-name').value = acc.name;
    const p = parseProxyString(acc.proxy || '');
    document.getElementById('proxy-host').value = p.host;
    document.getElementById('proxy-port').value = p.port;
    document.getElementById('proxy-user').value = p.user;
    document.getElementById('proxy-pass').value = p.pass;
    
    accountModal.classList.add('active');
};

window.handleDelete = (e, id) => {
    e.stopPropagation();
    if (confirm('确定删除该环境？数据将无法找回。')) {
        ipcRenderer.send('delete-account', id);
    }
};

// 3. 代理模式切换
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
    
    testStatus.innerText = '⏳ 正在检测...';
    testStatus.className = 'test-status-msg';
    
    const result = await ipcRenderer.invoke('test-proxy', parseProxyString(proxyStr));
    if (result.success) {
        testStatus.innerText = `✅ [${result.country}] IP: ${result.query}`;
        testStatus.style.color = '#22c55e';
        testProxyBtn.dataset.timezone = result.timezone;
    } else {
        testStatus.innerText = `❌ ${result.error || '连接失败'}`;
        testStatus.style.color = '#ef4444';
    }
};


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

// 4. 辅助函数
function resetForm() {
    document.getElementById('acc-name').value = '';
    document.getElementById('proxy-host').value = '';
    document.getElementById('proxy-port').value = '';
    document.getElementById('proxy-user').value = '';
    document.getElementById('proxy-pass').value = '';
    proxyUrlSimple.value = '';
    testStatus.innerText = '等待检测...';
    testStatus.style.color = '';
    delete testProxyBtn.dataset.timezone;
}

// 智能代理解析器：超级解析版（支持 Base64 和 荔枝 IP 非标格式）
function parseProxyString(str) {
    const result = { host: '', port: '', user: '', pass: '' };
    if (!str) return result;

    str = str.trim();

    // 处理 Base64 格式 (socks://Mjhm...)
    if (str.startsWith('socks://')) {
        try {
            const b64 = str.replace('socks://', '').split('?')[0]; // 移除可能存在的备注
            const decoded = atob(b64); // Base64 解码
            return parseProxyString(decoded); // 递归解析解码后的内容
        } catch (e) { console.error("Base64 decode failed", e); }
    }

    // 移除协议头（兼容 socks5/socks5h/http/socks）
    str = str.replace(/^(socks5?|http|socks5h|socks):\/\//i, '');

    // 格式 1: user:pass@ip:port
    const authAt = str.match(/(.*):(.*)@(.*):(\d+)/);
    if (authAt) {
        result.user = authAt[1]; result.pass = authAt[2];
        result.host = authAt[3]; result.port = authAt[4];
        return result;
    }

    // 格式 2: ip:port:user:pass (荔枝 IP 常见的非标 URL 格式)
    const parts = str.split(':');
    if (parts.length === 4) {
        result.host = parts[0]; result.port = parts[1];
        result.user = parts[2]; result.pass = parts[3];
        return result;
    }

    // 格式 3: ip:port (无验证)
    if (parts.length === 2 && !isNaN(parts[1])) {
        result.host = parts[0]; result.port = parts[1];
        return result;
    }

    // 格式 4: 标准 URL 后端宽容解析
    try {
        const urlStr = str.includes('@') ? 'socks5://' + str : 'socks5://' + str;
        const url = new URL(urlStr);
        result.host = url.hostname; result.port = url.port;
        result.user = url.username; result.pass = url.password;
    } catch (e) {}

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

// 5. IPC 和 初始化
async function initApp() {
    // 获取并显示真实版本号
    const version = await ipcRenderer.invoke('get-version');
    const label = document.getElementById('app-version-label');
    if (label) label.innerText = `V ${version} Purified`;

    ipcRenderer.on('accounts-list', (event, accounts) => renderAccounts(accounts));
    ipcRenderer.on('process-started', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('process-ended', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('chrome-not-found', () => chromeModal.classList.add('active'));
    
    btnDownloadChrome.onclick = () => ipcRenderer.send('open-chrome-download');
    btnSelectChrome.onclick = () => ipcRenderer.send('select-chrome-path');
    ipcRenderer.on('chrome-path-set', () => chromeModal.classList.remove('active'));

    ipcRenderer.send('get-accounts');
}

// 6. 真正的自动更新检查逻辑 (与主进程配合)
async function checkUpdates() {
    // 监听来自主进程的更新事件
    ipcRenderer.on('update-available', (event, info) => {
        document.getElementById('update-changelog').innerText = info.releaseNotes || "发现新版本，点击开始更新。";
        document.getElementById('update-modal').classList.add('active');
        document.getElementById('btn-do-update').onclick = () => {
             // 启动下载 (取决于主进程配置，通常 checkForUpdatesAndNotify 会自动开始或由手动触发)
             document.getElementById('update-progress-container').style.display = 'block';
             document.getElementById('btn-do-update').disabled = true;
        };
    });

    ipcRenderer.on('update-progress', (event, percent) => {
        const rounded = Math.round(percent);
        document.getElementById('update-progress-bar').style.width = `${rounded}%`;
        document.getElementById('update-status').innerText = `正在下载: ${rounded}%`;
    });

    ipcRenderer.on('update-ready', (event, info) => {
        const btn = document.getElementById('btn-do-update');
        btn.disabled = false;
        btn.innerText = "立即重启并更新";
        btn.onclick = () => {
            ipcRenderer.send('restart-app');
        };
    });
}
initApp();
checkUpdates();


