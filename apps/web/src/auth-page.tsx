import { useState, type FormEvent } from 'react';
import { Button, Card } from '@kitesync/ui';
import { api, type Session } from './api.js';

export function AuthPage({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'bootstrap' | 'invitation' | 'reset'>('login');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const password = String(data.get('password'));
      if (mode === 'reset') {
        await api.resetPassword(String(data.get('token')), password);
        setMode('login');
      } else {
        const username = String(data.get('username'));
        const session =
          mode === 'login'
            ? await api.login(username, password)
            : mode === 'invitation'
              ? await api.acceptInvitation(String(data.get('token')), password)
              : await api.bootstrap({
                  token: String(data.get('token')),
                  username,
                  displayName: String(data.get('displayName')),
                  password,
                });
        onAuthenticated(session);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接服务器');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-brand">
        <span className="brand-mark">K</span>
        <p>局域网文件，始终在掌控之中。</p>
        <h1>KiteSync</h1>
        <p className="muted">由你的服务器托管，以熟悉的桌面方式可靠同步。</p>
      </div>
      <Card className="auth-card">
        <div className="segmented">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            登录
          </button>
          <button
            className={mode === 'bootstrap' ? 'active' : ''}
            onClick={() => setMode('bootstrap')}
          >
            初始化
          </button>
          <button
            className={mode === 'invitation' ? 'active' : ''}
            onClick={() => setMode('invitation')}
          >
            接受邀请
          </button>
          <button className={mode === 'reset' ? 'active' : ''} onClick={() => setMode('reset')}>
            重置密码
          </button>
        </div>
        <h2>
          {mode === 'login'
            ? '欢迎回来'
            : mode === 'bootstrap'
              ? '创建首位管理员'
              : mode === 'invitation'
                ? '加入组织'
                : '设置新密码'}
        </h2>
        <form onSubmit={(event) => void submit(event)}>
          {mode !== 'login' && (
            <label>
              {mode === 'bootstrap' ? '一次性初始化令牌' : '一次性令牌'}
              <input name="token" required minLength={16} autoComplete="one-time-code" />
            </label>
          )}
          {mode === 'bootstrap' && (
            <>
              <label>
                显示名称
                <input name="displayName" required />
              </label>
            </>
          )}
          {(mode === 'login' || mode === 'bootstrap') && (
            <label>
              用户名
              <input name="username" required minLength={3} autoComplete="username" />
            </label>
          )}
          <label>
            密码
            <input
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <Button disabled={pending}>
            {pending
              ? '请稍候…'
              : mode === 'login'
                ? '登录'
                : mode === 'bootstrap'
                  ? '完成初始化'
                  : mode === 'invitation'
                    ? '接受邀请'
                    : '重置密码'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
