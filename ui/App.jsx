import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SquaresFour, FolderSimple, ArrowClockwise, Plus, MagnifyingGlass, Play, XCircle, PencilSimple, DotsThree, X, Check, Trash, Copy, Info, CircleNotch, Palette } from '@phosphor-icons/react';
import { AppearanceShortcut, AppearancePanel } from './Appearance.jsx';
import { checked, validateName, formatLastUsed, newerUpdate } from './client-model.js';

const api = window.electronAPI;
const Icon = ({ as: Component, ...props }) => <Component size={24} weight="regular" aria-hidden="true" {...props}/>;

function GlassDialog({ title, children, onClose, reduced }) {
  const ref = useRef(null), closing = useRef(false), timer = useRef();
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true; setLeaving(true); timer.current = setTimeout(onClose, reduced ? 0 : 150);
  };
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement;
    dialog.showModal(); dialog.querySelector('[data-autofocus]')?.focus();
    return () => { clearTimeout(timer.current); dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`glass-dialog ${leaving ? 'leaving' : ''}`} aria-labelledby="dialog-title"
    onCancel={e => { e.preventDefault(); close(); }} onClick={e => {
      if (e.target !== ref.current) return;
      const r = ref.current.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }}>
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" onClick={close} aria-label="关闭弹窗"><Icon as={X}/></button></div>
    {children(close)}
  </dialog>;
}

function NameForm({ mode, account, onSave, close }) {
  const [name, setName] = useState(account?.name || (mode === 'bulk' ? 'WhatsApp 业务' : ''));
  const [count, setCount] = useState('3'), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const lock = useRef(false);
  async function submit(e) {
    e.preventDefault(); if (lock.current) return;
    const result = validateName(name);
    if (result.error) return setError(result.error);
    if (mode === 'bulk' && (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 200)) return setError('每次可创建 1–200 个环境。');
    lock.current = true; setSaving(true); setError('');
    try { await onSave(result.value, Number(count)); close(); }
    catch (e) { setError(e.message); }
    finally { lock.current = false; setSaving(false); }
  }
  return <form id={mode === 'bulk' ? 'bulk-form' : 'account-form'} onSubmit={submit}>
    <label className="field-label" htmlFor="environment-name">{mode === 'bulk' ? '名称前缀' : '环境名称'}</label>
    <input id="environment-name" data-autofocus autoComplete="off" className="form-input" maxLength={200} value={name} disabled={saving}
      onChange={e => { setName(e.target.value); setError(''); }} placeholder="例如：WhatsApp 业务01" aria-describedby={error ? 'form-error' : undefined} aria-invalid={!!error}/>
    {mode === 'bulk' && <><label className="field-label" htmlFor="environment-count">创建数量</label><input id="environment-count" className="form-input" type="number" min="1" max="200" step="1" value={count} disabled={saving} onChange={e => { setCount(e.target.value); setError(''); }}/><p className="field-help">自动添加 -01、-02、-03 等序号。</p></>}
    {error && <p id="form-error" className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="button" type="button" onClick={close}>取消</button><button className="button primary" type="submit" disabled={saving}>{saving ? '保存中…' : mode === 'edit' ? '保存名称' : mode === 'bulk' ? '批量创建' : '创建环境'}</button></div>
  </form>;
}

function ConfirmAction({ children, label, danger, onConfirm, close }) {
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), lock = useRef(false);
  return <>{children}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button" data-autofocus onClick={close}>取消</button><button data-confirm className={`button ${danger ? 'danger' : 'primary'}`} disabled={saving} onClick={async () => {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { await onConfirm(); close(); } catch (e) { setError(e.message); }
    finally { lock.current = false; setSaving(false); }
  }}>{saving ? '处理中…' : label}</button></div></>;
}

function ContextMenu({ menu, onClose, onAction, readOnly, busy, statusKnown }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const outside = e => { if (!ref.current?.contains(e.target)) onClose(); }, dismiss = () => onClose();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, []);
  return createPortal(<div ref={ref} className="context-menu glass" role="menu" aria-label="环境操作" style={{ top: Math.max(8, Math.min(menu.y, window.innerHeight - 198)), left: Math.max(8, Math.min(menu.x - 188, window.innerWidth - 200)) }} onKeyDown={e => {
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') { onClose(); menu.trigger?.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
  }}>
    <button role="menuitem" onClick={() => onAction('copy')}><Icon as={Copy} size={20}/>复制 ID</button>
    <button role="menuitem" onClick={() => onAction('folder')}><Icon as={FolderSimple} size={20}/>打开数据目录</button>
    <button role="menuitem" disabled={busy || readOnly} onClick={() => onAction('edit')}><Icon as={PencilSimple} size={20}/>修改名称</button>
    <button role="menuitem" className="danger-text" disabled={busy || readOnly || !statusKnown} onClick={() => onAction('delete')}><Icon as={Trash} size={20}/>从列表删除</button>
  </div>, document.body);
}

export function App() {
  const [state, setState] = useState({ accounts: [], busy: false, readOnly: true, statusKnown: false, warning: '' });
  const [loaded, setLoaded] = useState(false), [query, setQuery] = useState(''), [modal, setModal] = useState(null), [menu, setMenu] = useState(null);
  const [toasts, setToasts] = useState([]), [pending, setPending] = useState(null), [progress, setProgress] = useState(null), [update, setUpdate] = useState({ type: 'idle' }), [version, setVersion] = useState('');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const positions = useRef(new Map()), operation = useRef(false), toastTimers = useRef(new Set()), focusAfterMove = useRef(null);
  const accounts = state.accounts, busy = state.busy || !!pending, blocked = !loaded || busy || state.readOnly;
  const running = accounts.filter(a => a.isRunning), idle = accounts.filter(a => !a.isRunning);
  const matches = a => `${a.name} ${a.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const visibleRunning = running.filter(matches), visibleIdle = idle.filter(matches);
  function snapshot() { positions.current = new Map([...document.querySelectorAll('[data-account]')].map(el => [el.dataset.account, el.getBoundingClientRect()])); }
  function applyState(next) { snapshot(); setState(next); setLoaded(true); }
  function applyUpdate(next) { setUpdate(current => newerUpdate(current, next)); }
  function notify(message, kind = 'success') {
    const id = crypto.randomUUID(); setToasts(t => [...t.slice(-2), { id, message, kind }]);
    const timer = setTimeout(() => { setToasts(t => t.filter(x => x.id !== id)); toastTimers.current.delete(timer); }, 5500); toastTimers.current.add(timer);
  }
  useEffect(() => {
    let mounted = true;
    const subscriptions = [api.onState(s => { if (mounted) applyState(s); }), api.onLaunchProgress(setProgress), api.onUpdate(s => { if (mounted) applyUpdate(s); })];
    checked(api.getState()).then(s => { if (mounted) applyState(s); }).catch(e => { if (mounted) setState(s => ({ ...s, warning: e.message })); });
    checked(api.getVersion()).then(v => { if (mounted) setVersion(v.version); }).catch(e => notify(e.message, 'error'));
    checked(api.getUpdateState()).then(result => { if (mounted) applyUpdate(result.update); }).catch(() => {});
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReduced(media.matches); media.addEventListener('change', change);
    return () => { mounted = false; subscriptions.forEach(fn => fn()); media.removeEventListener('change', change); toastTimers.current.forEach(clearTimeout); };
  }, []);
  useEffect(() => { document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'; }, [reduced]);
  useLayoutEffect(() => {
    document.querySelectorAll('[data-account]').forEach(el => {
      const old = positions.current.get(el.dataset.account), now = el.getBoundingClientRect();
      if (!reduced && old && (Math.abs(old.top - now.top) > 1 || Math.abs(old.left - now.left) > 1)) el.animate([{ transform: `translate(${old.left - now.left}px,${old.top - now.top}px)` }, { transform: 'translate(0,0)' }], { duration: 350, easing: 'cubic-bezier(.2,.85,.2,1)' });
    }); positions.current.clear();
    if (focusAfterMove.current && !pending) {
      document.querySelector(`[data-account="${CSS.escape(focusAfterMove.current)}"] [data-action="toggle"]`)?.focus({ preventScroll: true }); focusAfterMove.current = null;
    }
  }, [accounts, query, pending]);
  async function act(label, action) {
    if (operation.current) throw Error('请等待当前操作完成。');
    operation.current = true; setPending(label);
    try { return await action(); } finally { operation.current = false; setPending(null); }
  }
  async function attempt(action) { try { return await action(); } catch (e) { notify(e.message, 'error'); } }
  function openModal(type, account) { setMenu(null); setModal({ type, account }); }
  async function handleLaunchResult(result) {
    if (result.reason === 'chrome-not-found') { openModal('chrome'); return false; }
    await checked(Promise.resolve(result));
    if (result.warning) notify(result.warning, 'error');
    return true;
  }
  function closeResult(result) {
    if (result.failed) throw Error(`已关闭 ${result.closed} 个，${result.failed} 个未退出。${result.errors?.[0]?.message || '请检查 Chrome 提示后重试。'}`);
    notify(`已关闭 ${result.closed} 个环境`);
  }
  async function toggleAccount(a) {
    await attempt(() => act({ id: a.id, type: a.isRunning ? 'close' : 'launch' }, async () => {
      focusAfterMove.current = a.id;
      if (a.isRunning) closeResult(await checked(api.closeProfile(a.id)));
      else if (await handleLaunchResult(await api.launchProfile(a.id))) notify(`${a.name} · 已启动`);
    }));
  }
  async function launchAll() {
    setProgress(null);
    await attempt(() => act({ type: 'launchAll' }, async () => {
      const r = await api.launchAllProfiles();
      if (!(await handleLaunchResult(r))) return;
      notify(`已启动 ${r.launched} 个，跳过 ${r.skipped} 个${r.failed ? `，失败 ${r.failed} 个：${r.errors?.[0]?.message || '请重试'}` : ''}`, r.failed ? 'error' : 'success');
    }));
  }
  async function saveName(name, count) {
    await act({ type: 'save' }, async () => {
      if (modal.type === 'edit') await checked(api.updateAccount({ id: modal.account.id, name }));
      else if (modal.type === 'bulk') await checked(api.addBulkAccounts({ prefix: name, count }));
      else await checked(api.addAccount({ name }));
      setQuery(''); notify(modal.type === 'edit' ? '环境名称已保存' : '环境已创建');
    });
  }
  async function checkUpdate() { try { const result = await checked(api.checkUpdate()); applyUpdate(result.update); } catch (e) { notify(e.message, 'error'); } }
  const finishUpdate = () => attempt(() => act({ type: 'update' }, () => checked(api.restartUpdate())));
  const updateMessage = ({ idle: '可手动检查更新。收到服务端发布通知后，新版本会在后台下载。', checking: update.automatic ? '已收到发布通知，正在获取更新包信息…' : '正在检查更新…', available: `发现新版本 ${update.version || ''}，正在后台下载，可继续使用。`, progress: `正在后台下载 ${Math.round(Number(update.percent) || 0)}%，可继续使用。`, ready: `新版本${update.version ? ` v${update.version}` : ''}已准备好。点击「完成更新」将正常关闭全部浏览器环境，然后安装并重启客户端。`, none: '当前已是最新版本', development: '本地开发版本，不检查线上更新。', error: update.message || '更新失败，请稍后重试。' })[update.type];
  const pushMessage = ({ disabled: '推送服务尚未配置，手动检查仍可使用。', invalid: '推送地址配置有误，手动检查仍可使用。', connecting: '正在连接推送服务…', connected: '已连接推送服务 · 发布后即时通知', reconnecting: '推送连接已断开，正在重连；手动检查仍可使用。' })[update.pushConnection];
  const updateBusy = ['checking', 'available', 'progress'].includes(update.type);
  const title = modal && ({ new: '新建环境', bulk: '批量新建', edit: '编辑环境', delete: '从列表删除环境', closeAll: '关闭全部环境', update: '版本与更新', appearance: '外观设置', chrome: '选择 Chrome' })[modal.type];
  function row(a) {
    const loading = pending?.id === a.id, unknown = !state.statusKnown || a.statusUnknown;
    const label = unknown ? '待确认' : loading ? pending.type === 'launch' ? '启动中' : '关闭中' : a.isRunning ? '运行中' : '未启动';
    return <article key={a.id} data-account={a.id} className={`account-row ${a.isRunning ? 'is-running running' : ''}`} aria-label={a.name}>
      <div className="number-badge">{String(accounts.indexOf(a) + 1).padStart(2, '0')}</div>
      <div className="account-identity"><h3 title={a.name}>{a.name}</h3><span title={`ID ${a.id}`}>ID {a.id}</span></div>
      <span className={`status ${a.isRunning && !unknown ? 'green' : ''} ${loading ? 'pending' : ''}`}>{loading ? <Icon as={CircleNotch} className="spinner" size={16}/> : <span className="status-dot"/>}{label}</span>
      <time className="last-start" title={a.lastUsed || '尚未启动'}>{formatLastUsed(a.lastUsed)}</time>
      <div className="row-actions"><button className={`button row-toggle ${a.isRunning ? '' : 'primary'}`} data-action="toggle" disabled={!loaded || busy || unknown || (!a.isRunning && state.readOnly)} onClick={() => toggleAccount(a)} aria-label={`${a.isRunning ? '关闭' : '启动'} ${a.name}`}>{loading ? <Icon as={CircleNotch} size={20} className="spinner"/> : a.isRunning ? '关闭' : '启动'}</button>
        <button className="icon-button" title="打开数据目录" aria-label={`打开 ${a.name} 的数据目录`} onClick={() => attempt(() => checked(api.openProfileFolder(a.id)))}><Icon as={FolderSimple}/></button>
        <button className="icon-button edit-button" disabled={blocked} title="编辑名称" aria-label={`编辑 ${a.name}`} onClick={() => openModal('edit', a)}><Icon as={PencilSimple}/></button>
        <button className="icon-button more-button" title="更多操作" aria-label={`${a.name} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.id === a.id} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ id: a.id, x: r.right, y: r.bottom + 8, trigger: e.currentTarget }); }}><Icon as={DotsThree} size={27} weight="bold"/></button>
      </div></article>;
  }
  return <div className="app-shell">
    <aside className="sidebar glass" aria-label="主导航"><div className="brand"><img src="yutonglogo.png" alt="YT"/><strong>YT多开浏览器</strong></div>
      <nav><button className={`nav-item ${!modal || !['update', 'appearance'].includes(modal.type) ? 'selected' : ''}`} onClick={() => { setQuery(''); setMenu(null); setModal(null); }} aria-current={!modal ? 'page' : undefined}><Icon as={SquaresFour} size={29}/>环境</button>
        <button className="nav-item" id="open-root-folder-btn" onClick={() => attempt(() => checked(api.openProfilesRoot()))}><Icon as={FolderSimple} size={29}/>数据目录</button>
        <button className={`nav-item ${modal?.type === 'update' ? 'selected' : ''}`} id="nav-update-btn" onClick={() => openModal('update')}><Icon as={ArrowClockwise} size={29}/>更新{update.type === 'ready' && <span className="update-dot" aria-label="新版本已准备好"/>}</button>
        <button className={`nav-item ${modal?.type === 'appearance' ? 'selected' : ''}`} data-open-appearance onClick={() => openModal('appearance')}><Icon as={Palette} size={29}/>外观</button></nav>
      <AppearanceShortcut onOpen={() => openModal('appearance')}/>
    </aside>
    <main><header className="page-heading"><div><h1>多开环境</h1><p aria-live="polite">{loaded ? `${accounts.length} 个环境 · ${state.statusKnown ? `${running.length} 个运行中` : '正在核对状态'}` : '正在读取环境…'}</p></div>
      <div className="heading-actions"><button className="button large" id="bulk-account-btn" disabled={blocked} onClick={() => openModal('bulk')}><Icon as={Plus}/>批量新建</button><button className="button primary large" id="add-account-btn" disabled={blocked} onClick={() => openModal('new')}><Icon as={Plus} size={27}/>新建环境</button></div></header>
      <div id="storage-warning" className="storage-warning" role="alert" hidden={!state.warning}>{state.warning}{state.warning && <button className="text-button" onClick={() => attempt(async () => applyState(await checked(api.getState())))}>重新核对</button>}</div>
      <section className="command-bar glass" aria-label="环境搜索与批量操作"><div className="search-field"><Icon as={MagnifyingGlass} size={27}/><input id="profile-search" type="search" value={query} placeholder="搜索环境名称或 ID" aria-label="搜索环境名称或 ID" autoComplete="off" onChange={e => { snapshot(); setQuery(e.target.value); }}/>{query && <button className="clear-search" aria-label="清空搜索" onClick={() => { snapshot(); setQuery(''); }}><Icon as={XCircle} size={21}/></button>}</div>
        <div className="batch-actions"><button className="toolbar-button launch-all" id="launch-all-btn" disabled={blocked || !state.statusKnown || !idle.length} onClick={launchAll}><Icon as={pending?.type === 'launchAll' ? CircleNotch : Play} className={pending?.type === 'launchAll' ? 'spinner' : ''}/>{pending?.type === 'launchAll' ? progress ? `${progress.current}/${progress.total} 启动中` : '正在启动…' : '按序启动全部'}</button><button className="toolbar-button" id="close-all-btn" disabled={!loaded || busy || !state.statusKnown || !running.length} onClick={() => openModal('closeAll')}><Icon as={pending?.type === 'closeAll' ? CircleNotch : XCircle} className={pending?.type === 'closeAll' ? 'spinner' : ''}/>{pending?.type === 'closeAll' ? '正在关闭…' : '关闭全部'}</button></div></section>
      <div className="account-sections" aria-busy={busy || !loaded}>
        <section className="account-section" aria-labelledby="running-title"><div className="section-heading"><h2 id="running-title">运行中</h2><span className="count green">{visibleRunning.length}</span></div><div className="account-panel glass running-panel">{visibleRunning.map(row)}{!visibleRunning.length && <div className="empty-group"><Icon as={Play}/><span>{!loaded || !state.statusKnown ? '正在核对浏览器状态' : query ? '没有匹配的运行中环境' : '暂时没有运行中的环境'}</span></div>}</div></section>
        <section className="account-section" aria-labelledby="idle-title"><div className="section-heading"><h2 id="idle-title">{state.statusKnown ? '未启动' : '待确认'}</h2><span className="count">{visibleIdle.length}</span></div><div className="account-panel glass idle-panel">{visibleIdle.map(row)}{!visibleIdle.length && <div className="empty-group"><Icon as={SquaresFour} size={25}/><span>{!loaded ? '正在读取环境…' : query ? '没有匹配的环境' : accounts.length ? '所有环境都已启动' : '点击「新建环境」开始使用'}</span></div>}</div></section>
        {query && <p className="search-result" role="status">找到 {visibleRunning.length + visibleIdle.length} 个匹配环境 <button className="text-button" onClick={() => setQuery('')}>清空搜索</button></p>}
      </div><footer><span id="app-version-label">{version ? `v${version}` : ''}</span></footer>
    </main>
    <div className="toast-stack" aria-live="polite" aria-atomic="false">{toasts.map(t => <div className={`toast glass ${t.kind}`} key={t.id}><Icon as={t.kind === 'success' ? Check : Info} size={21}/><span>{t.message}</span><button aria-label="关闭提示" onClick={() => setToasts(rows => rows.filter(x => x.id !== t.id))}><Icon as={X} size={17}/></button></div>)}</div>
    {update.type === 'ready' && modal?.type !== 'update' && <section className="update-notice glass" aria-label="版本更新"><div className="update-notice-copy" role="status"><strong>新版本{update.version ? ` v${update.version}` : ''}已准备好</strong><span>将关闭全部浏览器环境并重启客户端</span></div><button id="finish-update-btn" className="button primary" disabled={!loaded || busy} onClick={finishUpdate}><Icon as={ArrowClockwise} size={18}/>{pending?.type === 'update' ? '正在重启…' : '完成更新'}</button></section>}
    {menu && <ContextMenu key={menu.id} menu={menu} onClose={() => setMenu(null)} readOnly={state.readOnly} busy={busy} statusKnown={state.statusKnown} onAction={action => {
      const a = accounts.find(a => a.id === menu.id); menu.trigger?.focus(); setMenu(null); if (!a) return;
      if (action === 'copy') attempt(async () => { try { await navigator.clipboard.writeText(a.id); notify('ID 已复制'); } catch { notify(`ID：${a.id}`, 'info'); } });
      else if (action === 'folder') attempt(() => checked(api.openProfileFolder(a.id)));
      else openModal(action, a);
    }}/>}
    {modal && <GlassDialog key={`${modal.type}-${modal.account?.id || ''}`} title={title} reduced={reduced} onClose={() => setModal(m => m === modal ? null : m)}>{close => <>
      {modal.type === 'appearance' && <AppearancePanel close={close}/>}
      {['new', 'bulk', 'edit'].includes(modal.type) && <NameForm mode={modal.type} account={modal.account} onSave={saveName} close={close}/>}
      {['delete', 'closeAll'].includes(modal.type) && <ConfirmAction close={close} danger={modal.type === 'delete'} label={modal.type === 'delete' ? '从列表删除' : '确认关闭'} onConfirm={() => act({ type: modal.type }, async () => {
        if (modal.type === 'closeAll') closeResult(await checked(api.closeAllProfiles()));
        else { await checked(api.deleteAccount(modal.account.id)); notify('已从列表删除，浏览器数据目录已保留'); }
      })}><div className="dialog-symbol"><Icon as={modal.type === 'delete' ? Trash : XCircle} size={32}/></div><p className="confirmation-copy">{modal.type === 'delete' ? `确定从列表删除「${modal.account.name}」吗？` : `关闭当前 ${running.length} 个浏览器环境？`}</p><p className="dialog-description">{modal.type === 'delete' ? '请先关闭此环境。此操作只删除列表记录，不删除浏览器数据目录。' : '会请求 Chrome 正常退出；如果浏览器未退出，将保留其运行状态，不会强制结束。'}</p></ConfirmAction>}
      {modal.type === 'chrome' && <><p className="dialog-description">未找到 Chrome，请选择已安装的 chrome.exe。</p><div className="dialog-actions"><button className="button" onClick={() => attempt(() => checked(api.openChromeDownload()))}>下载 Chrome</button><button className="button primary" onClick={() => attempt(async () => { const r = await checked(api.selectChromePath()); if (!r.canceled) { close(); notify('Chrome 路径已保存，请重新启动环境'); } })}>选择路径</button></div></>}
      {modal.type === 'update' && <><div className="about-brand"><img src="yutonglogo.png" alt=""/><strong>YT多开浏览器</strong><span>v{version}</span></div><p className={`dialog-description ${update.type === 'error' ? 'danger-text' : ''}`} role="status">{updateMessage}</p>{pushMessage && <p className="field-help" data-push-status>{pushMessage}</p>}{update.type === 'progress' && <progress aria-label="更新下载进度" max="100" value={Math.max(0, Math.min(100, Number(update.percent) || 0))}/>}<div className="dialog-actions"><button className="button" onClick={close}>关闭</button><button className="button primary" disabled={updateBusy || busy} onClick={() => update.type === 'ready' ? finishUpdate() : checkUpdate()}>{pending?.type === 'update' ? '正在重启…' : updateBusy ? '处理中…' : update.type === 'ready' ? '完成更新' : '检查更新'}</button></div></>}
    </>}</GlassDialog>}
  </div>;
}
