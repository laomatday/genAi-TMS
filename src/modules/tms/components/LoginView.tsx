import React, { useState } from 'react';
import { doLogin } from '@/core/auth/authService';
import { triggerHaptic } from '@/core/utils/helpers';
import type { Employee } from '@/shared/types';
import { APP_INFO } from '@/shared/constants';

interface Props {
  onLoginSuccess: (user: Employee) => void;
  onSessionEstablished: () => void;
}

const LoginView: React.FC<Props> = ({ onLoginSuccess, onSessionEstablished }) => {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    if (!account.trim() || !password) {
      setError('Vui lòng nhập tài khoản và mật khẩu.');
      return;
    }

    setError('');
    setLoading(true);
    const result = await doLogin(account, password);
    setLoading(false);

    if (result.success && result.data) {
      triggerHaptic('success');
      onLoginSuccess(result.data);
      return;
    }

    if ('sessionEstablished' in result && result.sessionEstablished) {
      onSessionEstablished();
      return;
    }

    triggerHaptic('error');
    setError(result.message || 'Đăng nhập thất bại. Kiểm tra lại thông tin và thử lại.');
  };

  return (
    <main className="page-bg relative flex h-full w-full flex-col justify-between overflow-hidden px-6 py-8 transition-colors duration-300">
      <div className="login-brand-orb pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-10" />
      <div className="pointer-events-none absolute -bottom-36 -left-28 h-80 w-80 rounded-full bg-primary/5 dark:bg-primary/10" />

      <div className="z-10 mx-auto flex w-full max-w-sm flex-1 flex-col justify-center animate-slide-up">
        <section className="mb-8 text-center">
          <div className="login-mark">
            <img src={APP_INFO.LOGO_URL} className="h-full w-full object-contain" alt={APP_INFO.BRAND} />
          </div>
          <p className="mb-1 text-sm font-bold text-primary">{APP_INFO.BRAND}</p>
          <h1 className="text-2xl font-bold tracking-tight ui-text-primary">{APP_INFO.PRODUCT_NAME}</h1>
          <p className="mt-2 text-sm leading-relaxed ui-text-secondary">
            Chấm công bằng QR, vị trí và thiết bị làm việc đã xác thực.
          </p>
        </section>

        <form
          className="login-card"
          onSubmit={(event) => {
            event.preventDefault();
            void handleLogin();
          }}
        >
          {error ? (
            <p role="alert" className="ui-note ui-note-danger animate-scale-in">
              <span className="material-symbols-rounded" aria-hidden="true">error</span>
              <span>{error}</span>
            </p>
          ) : null}

          <div className="ui-field">
            <label htmlFor="login-account" className="ui-field-label">Tài khoản</label>
            <div className="login-control">
              <span className="material-symbols-rounded login-control-icon" aria-hidden="true">person</span>
              <input
                id="login-account"
                type="text"
                value={account}
                inputMode="email"
                enterKeyHint="next"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setAccount(event.target.value)}
                className="ui-control login-control-input"
                placeholder="Mã nhân viên hoặc email"
              />
            </div>
          </div>

          <div className="ui-field">
            <label htmlFor="login-password" className="ui-field-label">Mật khẩu</label>
            <div className="login-control">
              <span className="material-symbols-rounded login-control-icon" aria-hidden="true">lock</span>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                enterKeyHint="go"
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                className="ui-control login-control-input login-control-input-trailing"
                placeholder="Nhập mật khẩu"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                onClick={() => setShowPassword((value) => !value)}
                className="login-control-reveal"
              >
                <span className="material-symbols-rounded" aria-hidden="true">{showPassword ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} className="ui-cta">
            {loading ? (
              <>
                <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                Đang đăng nhập
              </>
            ) : (
              <>
                Đăng nhập
                <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
              </>
            )}
          </button>
        </form>
      </div>

      <footer className="z-10 mt-4 pb-safe text-center">
        <p className="text-xs ui-text-muted">{APP_INFO.PRODUCT_NAME} · {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
};

export default LoginView;
