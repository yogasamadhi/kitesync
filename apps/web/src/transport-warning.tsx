export function UnencryptedLanWarning() {
  if (!shouldShowUnencryptedLanWarning(window.location.protocol, window.location.hostname)) {
    return null;
  }

  return (
    <div className="transport-warning global-transport-warning" role="alert">
      仅适用于可信局域网：当前管理界面使用 HTTP，登录和操作流量未加密。
    </div>
  );
}

export function shouldShowUnencryptedLanWarning(protocol: string, hostname: string) {
  if (protocol !== 'http:') return false;
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}
