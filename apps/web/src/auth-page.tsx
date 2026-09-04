import { useState, type FormEvent } from 'react';
import { Button, Card } from '@kitesync/ui';
import { api, type AuthSession } from './api.js';

export function AuthPage({
  setupRequired,
  onAuthenticated,
}: {
  setupRequired: boolean;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');

    if (setupRequired && password !== confirmation) {
      setError('两次输入的密码不一致');
      setPending(false);
      return;
    }

    try {
      const session = setupRequired ? await api.setup({ password }) : await api.login({ password });
      onAuthenticated(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接到本机 KiteSync');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-brand" aria-label="KiteSync 介绍">
        <span className="brand-mark">K</span>
        <p className="auth-kicker">你的文件，只在你选择的设备间流动。</p>
        <h1>KiteSync</h1>
        <p className="muted">
          无需云端账户。当前电脑就是一个独立节点，可与局域网中的其他设备直接同步。
        </p>
      </section>
      <Card className="auth-card">
        <p className="eyebrow">本机管理界面</p>
        <h2>{setupRequired ? '设置管理密码' : '欢迎回来'}</h2>
        <p className="auth-help">
          {setupRequired
            ? '这是首次启动。密码仅保存在当前电脑，用于保护管理界面。'
            : '输入这台电脑的管理密码。'}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            管理密码
            <input
              name="password"
              type="password"
              required
              minLength={setupRequired ? 12 : 1}
              autoFocus
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
            />
          </label>
          {setupRequired && (
            <label>
              再次输入密码
              <input
                name="confirmation"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <Button disabled={pending}>
            {pending ? '正在处理…' : setupRequired ? '完成设置' : '登录'}
          </Button>
        </form>
        <p className="local-note">地址栏中的本机地址不会经过 KiteSync 云服务。</p>
      </Card>
    </main>
  );
}
