import React, { useState } from 'react';
import { doLogin } from '@/core/auth/authService';
import { triggerHaptic } from '@/core/utils/helpers';
import type { Employee } from '@/shared/types';
import { APP_INFO } from '@/shared/constants';

interface Props {
  onLoginSuccess: (user: Employee) => void;
}

const LoginView: React.FC<Props> = ({ onLoginSuccess }) => {
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

    triggerHaptic('error');
    setError(result.message || 'Đăng nhập thất bại. Kiểm tra lại thông tin và thử lại.');
  };

  return (
    <main className="page-bg relative flex h-full w-full flex-col justify-between overflow-hidden px-6 py-8 transition-colors duration-300">
      <div className="login-brand-orb pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-10" />
      <div className="pointer-events-none absolute -bottom-36 -left-28 h-80 w-80 rounded-full bg-primary/5 dark:bg-primary/10" />

      <div className="z-10 mx-auto flex w-full max-w-sm flex-1 flex-col justify-center animate-slide-up">
        <section className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-3xl border border-slate-100 bg-white p-3 shadow-sm dark:border-dark-border dark:bg-dark-surface">
            <img src={APP_INFO.LOGO_URL} className="h-full w-full object-contain" alt={APP_INFO.BRAND} />
          </div>
          <p className="mb-1 text-sm font-bold text-primary">{APP_INFO.BRAND}</p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-dark-text-primary">{APP_INFO.PRODUCT_NAME}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-dark-text-secondary">
            Chấm công bằng QR, vị trí và thiết bị làm việc đã xác thực.
          </p>
        </section>

        <form
          className="space-y-4 rounded-3xl border border-slate-100 bg-white/90 p-5 shadow-sm backdrop-blur-xl dark:border-dark-border dark:bg-dark-surface/90"
          onSubmit={(event) => {
            event.preventDefault();
            void handleLogin();
          }}
        >
          {error ? (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-secondary-red/20 bg-secondary-red/10 p-3 animate-scale-in">
              <span className="material-symbols-rounded mt-0.5 text-lg text-secondary-red" aria-hidden="true">error</span>
              <span className="text-sm font-semibold leading-relaxed text-secondary-red">{error}</span>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="login-account" className="block text-sm font-semibold text-slate-600 dark:text-dark-text-secondary">Tài khoản</label>
            <div className="group relative">
              <span className="material-symbols-rounded absolute left-4 top-1/2 -translate-y-1/2 text-lg text-slate-400 transition-colors group-focus-within:text-primary" aria-hidden="true">person</span>
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
                className="input-field pl-11 pr-4 text-base"
                placeholder="Mã nhân viên hoặc email"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-sm font-semibold text-slate-600 dark:text-dark-text-secondary">Mật khẩu</label>
            <div className="group relative">
              <span className="material-symbols-rounded absolute left-4 top-1/2 -translate-y-1/2 text-lg text-slate-400 transition-colors group-focus-within:text-primary" aria-hidden="true">lock</span>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                enterKeyHint="go"
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                className="input-field pl-11 pr-12 text-base"
                placeholder="Nhập mật khẩu"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                onClick={() => setShowPassword((value) => !value)}
                className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-primary"
              >
                <span className="material-symbols-rounded text-lg" aria-hidden="true">{showPassword ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-bold text-white shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <><span className="material-symbols-rounded animate-spin text-base" aria-hidden="true">progress_activity</span>Đang đăng nhập</>
            ) : (
              <>Đăng nhập<span className="material-symbols-rounded text-lg" aria-hidden="true">arrow_forward</span></>
            )}
          </button>
        </form>
      </div>

      <footer className="z-10 mt-4 pb-safe text-center">
        <p className="text-xs text-slate-400 dark:text-dark-text-secondary">{APP_INFO.PRODUCT_NAME} · {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
};

export default LoginView;
