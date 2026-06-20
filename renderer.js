const { ipcRenderer, shell } = require('electron');

const accountList = document.getElementById('account-list');
const emptyState = document.getElementById('empty-state');
const addAccountBtn = document.getElementById('add-account-btn');
const emptyCreateBtn = document.getElementById('empty-create-btn');
const bulkAccountBtn = document.getElementById('bulk-account-btn');
const launchAllBtn = document.getElementById('launch-all-btn');
const closeAllBtn = document.getElementById('close-all-btn');
const profileSearch = document.getElementById('profile-search');
const totalAccountsLabel = document.getElementById('total-accounts');
const runningCountLabel = document.getElementById('running-count');
const todayCountLabel = document.getElementById('today-count');
const workspaceSubtitle = document.getElementById('workspace-subtitle');
const appVersionLabel = document.getElementById('app-version-label');
const chromeStateLabel = document.getElementById('chrome-state-label');

const drawer = document.getElementById('side-drawer');
const drawerTitle = document.getElementById('drawer-title');
const drawerSubtitle = document.getElementById('drawer-subtitle');
const drawerClose = document.getElementById('drawer-close');
const drawerCancel = document.getElementById('drawer-cancel');
const accountForm = document.getElementById('account-form');
const accNameInput = document.getElementById('acc-name');
const modalSave = document.getElementById('modal-save');

const bulkForm = document.getElementById('bulk-form');
const bulkPrefix = document.getElementById('bulk-prefix');
const bulkCount = document.getElementById('bulk-count');
const bulkCancel = document.getElementById('bulk-cancel');
const bulkPreview = document.getElementById('bulk-preview');

const dataPanel = document.getElementById('data-panel');
const dataProfileName = document.getElementById('data-profile-name');
const dataProfileId = document.getElementById('data-profile-id');
const dataProfileStatus = document.getElementById('data-profile-status');
const dataProfileLast = document.getElementById('data-profile-last');
const dataOpenFolder = document.getElementById('data-open-folder');

const appModal = document.getElementById('app-modal');
const modalIconWrap = document.getElementById('modal-icon-wrap');
const modalIcon = document.getElementById('modal-icon');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalActions = document.getElementById('modal-actions');
const updateProgressContainer = document.getElementById('update-progress-container');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateStatus = document.getElementById('update-status');
const updateChangelog = document.getElementById('update-changelog');
const toastHost = document.getElementById('toast-host');
const updateDock = document.getElementById('update-dock');
const updateDockTitle = document.getElementById('update-dock-title');
const updateDockDetail = document.getElementById('update-dock-detail');
const updateDockProgress = document.getElementById('update-dock-progress');
const updateDockBar = document.getElementById('update-dock-bar');
const updateDockAction = document.getElementById('update-dock-action');

let isEditMode = false;
let currentEditId = null;
let currentDataId = null;
let accountsData = [];
let activeFilter = 'all';
let isLaunchingAll = false;
let isClosingAll = false;

const ICONS = {
    grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h4"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v6h-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 4 14 8-14 8Z"/></svg>',
    'x-circle': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>'
};

function mountStaticIcons() {
    document.querySelectorAll('[data-icon]').forEach(node => {
        const icon = ICONS[node.dataset.icon];
        if (icon) node.innerHTML = icon;
    });
}

function getDisplayName(acc, index) {
    const trimmed = (acc.name || '').trim();
    return trimmed || String(index + 1);
}

function getStatus(acc) {
    return acc.isRunning ? { key: 'running', label: '运行中' } : { key: 'idle', label: '未启动' };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function isToday(value) {
    if (!value) return false;
    return value.includes(new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }));
}

function updateStats(accounts) {
    const runningCount = accounts.filter(acc => acc.isRunning).length;
    const todayCount = accounts.filter(acc => isToday(acc.lastUsed)).length;

    totalAccountsLabel.textContent = accounts.length;
    runningCountLabel.textContent = runningCount;
    todayCountLabel.textContent = todayCount;
    workspaceSubtitle.textContent = `${accounts.length} 个独立浏览器环境`;
}

function getRunningCount(accounts = accountsData) {
    return accounts.filter(acc => acc.isRunning).length;
}

function getIdleCount(accounts = accountsData) {
    return accounts.filter(acc => !acc.isRunning).length;
}

function setButtonLabel(button, label) {
    const labelNode = button?.querySelector('.btn-label');
    if (labelNode) labelNode.textContent = label;
}

function updateBatchButtonsState() {
    const totalCount = accountsData.length;
    const idleCount = getIdleCount();
    const runningCount = getRunningCount();

    launchAllBtn.disabled = isLaunchingAll || isClosingAll || totalCount === 0 || idleCount === 0;
    closeAllBtn.disabled = isLaunchingAll || isClosingAll || runningCount === 0;
    setButtonLabel(launchAllBtn, isLaunchingAll ? '正在按序启动' : '按序启动全部');
    setButtonLabel(closeAllBtn, isClosingAll ? '正在关闭' : '关闭全部');
}

function getFilteredAccounts() {
    const query = (profileSearch.value || '').trim().toLowerCase();
    return accountsData.filter((acc, index) => {
        const status = getStatus(acc).key;
        const filterMatch =
            activeFilter === 'all' ||
            (activeFilter === 'running' && status === 'running') ||
            (activeFilter === 'idle' && status === 'idle');
        if (!filterMatch) return false;
        if (!query) return true;

        const searchParts = [acc.name || '', getDisplayName(acc, index), String(acc.id || ''), String(acc.id || '').slice(-6), String(index + 1)];
        return searchParts.join(' ').toLowerCase().includes(query);
    });
}

function renderAccounts(accounts) {
    accountsData = accounts;
    updateStats(accounts);
    updateBatchButtonsState();

    const visibleAccounts = getFilteredAccounts();
    accountList.innerHTML = '';
    emptyState.hidden = visibleAccounts.length !== 0;

    if (visibleAccounts.length === 0) return;

    visibleAccounts.forEach((acc) => {
        const originalIndex = accountsData.findIndex(item => item.id === acc.id);
        const status = getStatus(acc);
        const displayName = getDisplayName(acc, originalIndex);
        const row = document.createElement('article');
        row.className = `account-row ${acc.isRunning ? 'running' : ''}`;
        row.dataset.id = acc.id;
        row.innerHTML = `
            <div class="account-cell account-main">
                <div class="account-avatar">${String(originalIndex + 1).padStart(2, '0')}</div>
                <div class="account-text">
                    <strong title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</strong>
                    <span>ID ${escapeHtml(String(acc.id).slice(-6).padStart(6, '0'))}</span>
                </div>
            </div>
            <div class="account-cell"><span class="status-badge ${status.key}">${status.label}</span></div>
            <div class="account-cell muted">${escapeHtml(acc.lastUsed || '暂无记录')}</div>
            <div class="account-cell">已保存</div>
            <div class="account-cell row-actions">
                <button class="row-start ${acc.isRunning ? 'running' : ''}" type="button" data-action="launch" ${acc.isRunning ? 'disabled' : ''}>${acc.isRunning ? '运行中' : '启动'}</button>
                <button class="icon-btn" title="数据目录" type="button" data-action="data">${ICONS.folder}</button>
                <button class="icon-btn" title="编辑" type="button" data-action="edit">${ICONS.edit}</button>
                <button class="icon-btn danger" title="删除" type="button" data-action="delete">${ICONS.trash}</button>
            </div>
        `;
        accountList.appendChild(row);
    });
}

function setDrawerMode(mode) {
    accountForm.hidden = mode !== 'account';
    bulkForm.hidden = mode !== 'bulk';
    dataPanel.hidden = mode !== 'data';
}

function openDrawer() {
    drawer.classList.add('active');
    drawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
    drawer.classList.remove('active');
    drawer.setAttribute('aria-hidden', 'true');
    isEditMode = false;
    currentEditId = null;
    currentDataId = null;
}

function openCreateDrawer() {
    setDrawerMode('account');
    isEditMode = false;
    currentEditId = null;
    drawerTitle.textContent = '新建环境';
    drawerSubtitle.textContent = '创建一个独立的浏览器环境。';
    modalSave.textContent = '创建';
    accNameInput.value = '';
    openDrawer();
    setTimeout(() => accNameInput.focus(), 80);
}

function openEditDrawer(id) {
    const acc = accountsData.find(item => item.id === id);
    if (!acc) return;
    setDrawerMode('account');
    isEditMode = true;
    currentEditId = id;
    drawerTitle.textContent = '编辑环境';
    drawerSubtitle.textContent = '只修改名称，不影响该环境的登录数据。';
    modalSave.textContent = '保存';
    accNameInput.value = acc.name || '';
    openDrawer();
    setTimeout(() => accNameInput.focus(), 80);
}

function renderBulkPreview() {
    const prefix = bulkPrefix.value.trim() || '账号';
    const count = Math.max(1, Math.min(200, Number.parseInt(bulkCount.value, 10) || 1));
    const width = String(count).length < 2 ? 2 : String(count).length;
    const sample = [1, 2, 3, count].filter((item, index, arr) => arr.indexOf(item) === index);
    bulkPreview.innerHTML = sample.map(i => `
        <div class="preview-row">
            <span>${escapeHtml(prefix)}-${String(i).padStart(width, '0')}</span>
            <strong>ID 自动生成</strong>
        </div>
    `).join('');
}

function openBulkDrawer() {
    setDrawerMode('bulk');
    drawerTitle.textContent = '批量新建';
    drawerSubtitle.textContent = '一次创建多个连续编号的独立环境。';
    bulkPrefix.value = '账号';
    bulkCount.value = '10';
    renderBulkPreview();
    openDrawer();
    setTimeout(() => bulkPrefix.focus(), 80);
}

function openDataDrawer(id) {
    const acc = accountsData.find(item => item.id === id);
    if (!acc) return;
    currentDataId = id;
    const status = getStatus(acc);
    setDrawerMode('data');
    drawerTitle.textContent = '数据目录';
    drawerSubtitle.textContent = '查看和打开该环境对应的本地数据。';
    dataProfileName.textContent = acc.name || '未命名环境';
    dataProfileId.textContent = `ID ${String(acc.id).slice(-6).padStart(6, '0')}`;
    dataProfileStatus.textContent = status.label;
    dataProfileLast.textContent = acc.lastUsed || '暂无记录';
    openDrawer();
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastHost.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 180);
    }, 2400);
}

function closeModal() {
    appModal.hidden = true;
    modalActions.innerHTML = '';
    updateProgressContainer.hidden = true;
    updateChangelog.hidden = true;
    modalIconWrap.className = 'modal-icon';
}

function showModal({ icon = 'info', tone = '', title, message, actions = [] }) {
    modalIcon.dataset.icon = icon;
    modalIcon.innerHTML = ICONS[icon] || ICONS.info;
    modalIconWrap.className = `modal-icon ${tone}`;
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalActions.innerHTML = '';
    actions.forEach(action => {
        const button = document.createElement('button');
        button.className = `btn ${action.variant || ''}`.trim();
        button.type = 'button';
        button.textContent = action.label;
        button.onclick = action.onClick;
        modalActions.appendChild(button);
    });
    appModal.hidden = false;
}

function confirmDelete(id) {
    const acc = accountsData.find(item => item.id === id);
    if (!acc) return;
    showModal({
        icon: 'trash',
        tone: 'danger',
        title: '删除这个环境？',
        message: `${acc.name || '该环境'} 会从列表移除。浏览器数据目录会保留在本机，避免误删登录数据。`,
        actions: [
            { label: '取消', onClick: closeModal },
            {
                label: '删除环境',
                variant: 'danger',
                onClick: () => {
                    ipcRenderer.send('delete-account', id);
                    closeModal();
                    closeDrawer();
                    showToast('环境已删除');
                }
            }
        ]
    });
}

async function launchAllProfiles() {
    const idleCount = getIdleCount();
    if (accountsData.length === 0) return showToast('请先创建环境');
    if (idleCount === 0) return showToast('所有环境都已在运行');

    isLaunchingAll = true;
    updateBatchButtonsState();
    showToast(`开始按顺序启动 ${idleCount} 个环境`);

    try {
        const result = await ipcRenderer.invoke('launch-all-profiles');
        if (result?.reason === 'chrome-not-found') return;
        if (result?.launched > 0) {
            showToast(`已按顺序启动 ${result.launched} 个环境`);
        } else {
            showToast('没有需要启动的环境');
        }
    } catch (error) {
        showToast('批量启动失败，请重试');
    } finally {
        isLaunchingAll = false;
        updateBatchButtonsState();
        ipcRenderer.send('get-accounts');
    }
}

function confirmCloseAllProfiles() {
    const runningCount = getRunningCount();
    if (runningCount === 0) return showToast('当前没有运行中的环境');

    showModal({
        icon: 'x-circle',
        tone: 'danger',
        title: '关闭全部浏览器？',
        message: `将关闭当前 ${runningCount} 个正在运行的浏览器环境，登录数据会继续保留。`,
        actions: [
            { label: '取消', onClick: closeModal },
            {
                label: '关闭全部',
                variant: 'danger',
                onClick: closeAllProfiles
            }
        ]
    });
}

async function closeAllProfiles() {
    isClosingAll = true;
    updateBatchButtonsState();

    try {
        const result = await ipcRenderer.invoke('close-all-profiles');
        closeModal();
        const closedCount = result?.closed || 0;
        showToast(closedCount > 0 ? `已关闭 ${closedCount} 个浏览器环境` : '没有需要关闭的浏览器');
    } catch (error) {
        closeModal();
        showToast('关闭全部失败，请重试');
    } finally {
        isClosingAll = false;
        updateBatchButtonsState();
        ipcRenderer.send('get-accounts');
    }
}

function handleManualUpdate() {
    setUpdateDockState('checking', {
        title: '正在检查更新',
        detail: '正在连接 GitHub Release'
    });
    ipcRenderer.send('manual-check-update');
}

function setUpdateDockState(state, options = {}) {
    const {
        title = '',
        detail = '',
        progress = null,
        actionLabel = '',
        onAction = null
    } = options;

    updateDock.hidden = state === 'hidden';
    updateDock.className = `update-dock ${state}`;
    updateDockTitle.textContent = title;
    updateDockDetail.textContent = detail;

    const hasProgress = typeof progress === 'number';
    updateDockProgress.hidden = !hasProgress;
    if (hasProgress) {
        const value = Math.max(0, Math.min(100, progress));
        updateDockBar.style.width = `${value}%`;
    }

    updateDockAction.hidden = !actionLabel;
    updateDockAction.disabled = false;
    updateDockAction.textContent = actionLabel;
    updateDockAction.onclick = onAction || null;
}

async function initApp() {
    mountStaticIcons();
    const version = await ipcRenderer.invoke('get-version');
    appVersionLabel.textContent = `V ${version}`;

    ipcRenderer.on('accounts-list', (event, accounts) => renderAccounts(accounts));
    ipcRenderer.on('process-started', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('process-ended', () => ipcRenderer.send('get-accounts'));
    ipcRenderer.on('launch-all-progress', (event, payload) => {
        if (!isLaunchingAll || !payload?.total) return;
        setButtonLabel(launchAllBtn, `启动 ${payload.current}/${payload.total}`);
    });
    ipcRenderer.on('chrome-not-found', () => {
        chromeStateLabel.textContent = '未配置';
        showModal({
            icon: 'warn',
            tone: 'warning',
            title: '未检测到 Chrome',
            message: '需要指定 Chrome.exe 才能启动独立浏览器环境。你可以安装 Chrome，或手动选择已安装的路径。',
            actions: [
                { label: '下载 Chrome', onClick: () => shell.openExternal('https://www.google.com/chrome/') },
                { label: '选择路径', variant: 'primary', onClick: () => ipcRenderer.send('select-chrome-path') }
            ]
        });
    });

    addAccountBtn.onclick = openCreateDrawer;
    emptyCreateBtn.onclick = openCreateDrawer;
    bulkAccountBtn.onclick = openBulkDrawer;
    launchAllBtn.onclick = launchAllProfiles;
    closeAllBtn.onclick = confirmCloseAllProfiles;
    drawerClose.onclick = closeDrawer;
    drawerCancel.onclick = closeDrawer;
    bulkCancel.onclick = closeDrawer;
    document.getElementById('nav-update-btn').onclick = handleManualUpdate;
    document.getElementById('open-root-folder-btn').onclick = () => ipcRenderer.send('open-profiles-root');

    accountForm.onsubmit = (event) => {
        event.preventDefault();
        const name = accNameInput.value.trim();
        if (!name) return showToast('请输入环境名称');
        if (isEditMode) {
            ipcRenderer.send('update-account', { id: currentEditId, name });
            showToast('环境名称已保存');
        } else {
            ipcRenderer.send('add-account', { name });
            showToast('环境已创建');
        }
        closeDrawer();
    };

    bulkForm.onsubmit = (event) => {
        event.preventDefault();
        const prefix = bulkPrefix.value.trim() || '账号';
        const count = Number.parseInt(bulkCount.value, 10);
        if (!Number.isInteger(count) || count < 1 || count > 200) return showToast('请输入 1 到 200 之间的数量');
        ipcRenderer.send('add-bulk-accounts', { prefix, count });
        showToast(`已创建 ${count} 个环境`);
        closeDrawer();
    };

    bulkPrefix.addEventListener('input', renderBulkPreview);
    bulkCount.addEventListener('input', renderBulkPreview);
    dataOpenFolder.onclick = () => {
        if (currentDataId) ipcRenderer.send('open-profile-folder', currentDataId);
    };

    profileSearch.addEventListener('input', () => renderAccounts(accountsData));
    document.querySelectorAll('.segment').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.segment').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            activeFilter = button.dataset.filter || 'all';
            renderAccounts(accountsData);
        });
    });

    accountList.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        const row = event.target.closest('.account-row');
        if (!row) return;
        const id = row.dataset.id;
        if (!button) {
            openDataDrawer(id);
            return;
        }
        const action = button.dataset.action;
        if (action === 'launch') ipcRenderer.send('launch-profile', id);
        if (action === 'data') openDataDrawer(id);
        if (action === 'edit') openEditDrawer(id);
        if (action === 'delete') confirmDelete(id);
    });

    ipcRenderer.on('update-checking', (event, payload) => {
        if (!payload?.manual) return;
        setUpdateDockState('checking', {
            title: '正在检查更新',
            detail: '正在连接 GitHub Release'
        });
    });

    ipcRenderer.on('update-available', (event, info) => {
        setUpdateDockState('downloading', {
            title: `发现新版本 ${info?.version || ''}`.trim(),
            detail: '正在后台下载更新',
            progress: 0
        });
    });

    ipcRenderer.on('update-progress', (event, percent) => {
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        setUpdateDockState('downloading', {
            title: '正在下载更新',
            detail: `${value.toFixed(0)}%`,
            progress: value
        });
    });

    ipcRenderer.on('update-ready', () => {
        setUpdateDockState('ready', {
            title: '更新已下载',
            detail: '点击后关闭浏览器环境并重启客户端',
            progress: 100,
            actionLabel: '完成更新',
            onAction: () => {
                updateDockAction.disabled = true;
                updateDockAction.textContent = '正在重启';
                updateDockTitle.textContent = '正在完成更新';
                updateDockDetail.textContent = '正在关闭浏览器环境并重启客户端';
                ipcRenderer.send('restart-app');
            }
        });
    });

    ipcRenderer.on('update-error', () => {
        setUpdateDockState('error', {
            title: '更新失败',
            detail: '网络异常或下载失败',
            actionLabel: '重试',
            onAction: handleManualUpdate
        });
    });

    ipcRenderer.on('update-not-available', (event, payload) => {
        if (!payload?.manual) return;
        setUpdateDockState('hidden');
        showToast('当前已是最新版本');
    });
    ipcRenderer.on('chrome-path-set', () => {
        chromeStateLabel.textContent = '已连接';
        closeModal();
        showToast('Chrome 路径已保存');
    });

    appModal.addEventListener('click', event => {
        if (event.target === appModal) closeModal();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (!appModal.hidden) closeModal();
            else closeDrawer();
        }
    });

    ipcRenderer.send('get-accounts');
}

document.addEventListener('DOMContentLoaded', initApp);
