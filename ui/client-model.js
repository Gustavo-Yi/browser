export function validateName(value) {
    const name = value.trim();
    return name && name.length <= 200 ? { value: name } : { error: '环境名称需要为 1 到 200 个字符。' };
}
export function formatLastUsed(value) {
    if (!value) return '尚未启动';
    // Only format a recognised date; preserve legacy text if it cannot be parsed.
    const match = value.match(/(?:\d{4}[\/-])?(\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}:\d{2})/);
    return match ? `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')} ${match[3]}` : value;
}
export async function checked(promise) {
    const result = await promise;
    if (!result?.ok) throw new Error(result?.message || '操作未成功，请重试。');
    return result;
}
// An initial IPC snapshot may arrive after a newer pushed event.
export function newerUpdate(current, incoming) {
    return incoming && (incoming.revision ?? -1) >= (current.revision ?? -1) ? incoming : current;
}
